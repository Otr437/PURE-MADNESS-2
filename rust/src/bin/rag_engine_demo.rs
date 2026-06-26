//! Demo binary for the RAG engine. Library code lives in src/rag_engine.rs.
//! Run with: cargo run --bin rag_engine_demo

use anyhow::Result;
use rag_ai_rust::rag_engine::{Document, RAGEngine, DEFAULT_TOP_K};

#[tokio::main]
async fn main() -> Result<()> {
    let engine = RAGEngine::new("demo").await?;

    let docs = vec![
        Document {
            content:  "Rust is a systems programming language focused on safety, speed, and concurrency.".to_string(),
            metadata: [("source".to_string(), "rust_docs".to_string())].into(),
            doc_id:   None,
        },
        Document {
            content:  "RAG augments LLMs with retrieval. Documents are chunked, embedded, and stored in a vector DB.".to_string(),
            metadata: [("source".to_string(), "rag_survey".to_string())].into(),
            doc_id:   None,
        },
        Document {
            content:  "Qdrant is a high-performance vector search engine written in Rust.".to_string(),
            metadata: [("source".to_string(), "qdrant_docs".to_string())].into(),
            doc_id:   None,
        },
    ];

    let count = engine.ingest(docs.clone()).await?;
    println!("Ingested {} docs → {} chunks", docs.len(), count);

    let ctx = engine.retrieve_as_context("What is RAG?", DEFAULT_TOP_K).await?;
    println!("\nContext for 'What is RAG?':\n{}", ctx);

    Ok(())
}
