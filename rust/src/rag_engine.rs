// RAG Engine — Rust
// Ingest documents, embed, store in Qdrant, retrieve context for agent loops.
//
// Add to Cargo.toml:
//   [dependencies]
//   qdrant-client = "1.13"
//   reqwest = { version = "0.12", features = ["json"] }
//   serde = { version = "1", features = ["derive"] }
//   serde_json = "1"
//   sha2 = "0.10"
//   tokio = { version = "1", features = ["full"] }
//   anyhow = "1"
//   hex = "0.4"
//
// export ANTHROPIC_API_KEY=sk-ant-...
// export QDRANT_URL=http://localhost:6333

use std::collections::HashMap;
use std::env;

use anyhow::{Context, Result};
use qdrant_client::prelude::*;
use qdrant_client::qdrant::{
    CreateCollectionBuilder, Distance, SearchPointsBuilder, UpsertPointsBuilder, VectorsConfigBuilder,
    VectorParamsBuilder, PointStruct, Value, vectors_config, vectors,
};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Config ─────────────────────────────────────────────────────────────────────
const EMBEDDING_DIM: u64 = 1024;
const COLLECTION_PREFIX: &str = "rag_";
pub const DEFAULT_TOP_K: u64 = 5;
const CHUNK_SIZE: usize = 800;
const CHUNK_OVERLAP: usize = 120;

// ── Models ─────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub content:  String,
    pub metadata: HashMap<String, String>,
    pub doc_id:   Option<String>,
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub text:      String,
    pub doc_id:    String,
    pub chunk_idx: usize,
    pub metadata:  HashMap<String, String>,
    pub chunk_id:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrievedChunk {
    pub text:      String,
    pub score:     f32,
    pub doc_id:    String,
    pub chunk_idx: usize,
    pub metadata:  HashMap<String, String>,
}

// ── Helpers ────────────────────────────────────────────────────────────────────
fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

pub fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    while start < bytes.len() {
        let end = (start + CHUNK_SIZE).min(bytes.len());
        // Find valid UTF-8 boundary
        let mut boundary = end;
        while boundary > start && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let mut chunk = &text[start..boundary];
        let mut next_start = boundary;
        if boundary < bytes.len() {
            for sep in ["\n\n", "\n", ". ", " "] {
                if let Some(pos) = chunk.rfind(sep) {
                    if pos > CHUNK_SIZE / 2 {
                        chunk = &text[start..start + pos + sep.len()];
                        next_start = start + pos + sep.len();
                        break;
                    }
                }
            }
        }
        let trimmed = chunk.trim().to_string();
        if !trimmed.is_empty() {
            chunks.push(trimmed);
        }
        if next_start <= start { break; }
        start = next_start.saturating_sub(CHUNK_OVERLAP);
    }
    chunks
}

// Deterministic pseudo-embedding for testing.
fn pseudo_embed(texts: &[String]) -> Vec<Vec<f32>> {
    texts.iter().map(|text| {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        let digest = hasher.finalize();
        let mut vec: Vec<f32> = (0..EMBEDDING_DIM as usize)
            .map(|i| (digest[i % digest.len()] as f32) / 255.0 * 2.0 - 1.0)
            .collect();
        let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-10);
        vec.iter_mut().for_each(|v| *v /= norm);
        vec
    }).collect()
}

// ── Anthropic embedding request ───────────────────────────────────────────────
#[derive(Serialize)]
struct EmbedRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
}

#[derive(Deserialize)]
struct EmbedItem {
    embedding: Vec<f32>,
}

async fn embed_texts_api(http: &HttpClient, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let api_key = env::var("ANTHROPIC_API_KEY").context("ANTHROPIC_API_KEY not set")?;
    let resp = http
        .post("https://api.anthropic.com/v1/embeddings")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "embeddings-2025-01-01")
        .json(&EmbedRequest { model: "voyage-3".to_string(), input: texts.clone() })
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let body: EmbedResponse = r.json().await?;
            Ok(body.data.into_iter().map(|i| i.embedding).collect())
        }
        _ => {
            // Fallback to pseudo-embedding
            Ok(pseudo_embed(&texts))
        }
    }
}

// ── RAG Engine ─────────────────────────────────────────────────────────────────
pub struct RAGEngine {
    collection_name: String,
    qdrant:          QdrantClient,
    http:            HttpClient,
}

impl RAGEngine {
    pub async fn new(name: &str) -> Result<Self> {
        let url = env::var("QDRANT_URL").unwrap_or_else(|_| "http://localhost:6333".to_string());
        let config = QdrantClientConfig::from_url(&url);
        let qdrant = QdrantClient::new(Some(config))?;
        let engine = Self {
            collection_name: format!("{}{}", COLLECTION_PREFIX, name),
            qdrant,
            http: HttpClient::new(),
        };
        engine.ensure_collection().await?;
        Ok(engine)
    }

    async fn ensure_collection(&self) -> Result<()> {
        if !self.qdrant.collection_exists(&self.collection_name).await? {
            self.qdrant
                .create_collection(&CreateCollectionBuilder::new(&self.collection_name)
                    .vectors_config(VectorsConfigBuilder::new().params_map(
                        [("".to_string(), VectorParamsBuilder::new(EMBEDDING_DIM, Distance::Cosine).build())]
                    )).build())
                .await
                .context("create_collection")?;
            eprintln!("[rag] Collection created: {}", self.collection_name);
        }
        Ok(())
    }

    pub async fn ingest(&self, documents: Vec<Document>) -> Result<usize> {
        let mut all_chunks: Vec<Chunk> = Vec::new();
        for doc in &documents {
            let id = doc.doc_id.clone().unwrap_or_else(|| sha256_hex(&doc.content));
            for (i, text) in chunk_text(&doc.content).into_iter().enumerate() {
                let mut meta = doc.metadata.clone();
                meta.insert("source_doc_id".to_string(), id.clone());
                let chunk_id = sha256_hex(&format!("{}:{}", id, i));
                all_chunks.push(Chunk { text, doc_id: id.clone(), chunk_idx: i, metadata: meta, chunk_id });
            }
        }

        let batch_size = 32;
        for batch in all_chunks.chunks(batch_size) {
            let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
            let vecs = embed_texts_api(&self.http, texts).await?;
            let points: Vec<PointStruct> = batch.iter().zip(vecs.iter()).map(|(c, vec)| {
                let id_bytes = c.chunk_id.as_bytes();
                let mut num_id = 0u64;
                for b in &id_bytes[..8.min(id_bytes.len())] {
                    num_id = num_id.wrapping_mul(256).wrapping_add(*b as u64);
                }
                let meta_json = serde_json::to_string(&c.metadata).unwrap_or_default();
                PointStruct::new(
                    num_id,
                    vec.clone(),
                    [
                        ("text".to_string(),      Value::from(c.text.as_str())),
                        ("doc_id".to_string(),     Value::from(c.doc_id.as_str())),
                        ("chunk_idx".to_string(),  Value::from(c.chunk_idx as i64)),
                        ("metadata".to_string(),   Value::from(meta_json.as_str())),
                    ].into_iter().collect::<HashMap<_, _>>(),
                )
            }).collect();

            self.qdrant
                .upsert_points(&UpsertPointsBuilder::new(&self.collection_name, points).build())
                .await
                .context("upsert_points")?;
        }
        Ok(all_chunks.len())
    }

    pub async fn retrieve(&self, query: &str, top_k: u64) -> Result<Vec<RetrievedChunk>> {
        let vecs = embed_texts_api(&self.http, vec![query.to_string()]).await?;
        let results = self.qdrant
            .search_points(&SearchPointsBuilder::new(
                &self.collection_name, vecs[0].clone(), top_k,
            ).with_payload(true).build())
            .await
            .context("search_points")?;

        Ok(results.result.into_iter().map(|r| {
            let text      = r.payload.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let doc_id    = r.payload.get("doc_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let chunk_idx = r.payload.get("chunk_idx").and_then(|v| v.as_integer()).unwrap_or(0) as usize;
            let metadata  = r.payload.get("metadata")
                .and_then(|v| serde_json::from_str(v.as_str().unwrap_or("{}")).ok())
                .unwrap_or_default();
            RetrievedChunk { text, score: r.score, doc_id, chunk_idx, metadata }
        }).collect())
    }

    pub async fn retrieve_as_context(&self, query: &str, top_k: u64) -> Result<String> {
        let chunks = self.retrieve(query, top_k).await?;
        if chunks.is_empty() {
            return Ok("No relevant context found.".to_string());
        }
        Ok(chunks.iter().enumerate()
            .map(|(i, c)| format!("[{}] (score={:.3}) {}", i + 1, c.score, c.text))
            .collect::<Vec<_>>()
            .join("\n\n"))
    }
}
