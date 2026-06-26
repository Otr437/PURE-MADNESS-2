// Eval Harness — Rust
// Measures retrieval quality: Precision@K, Recall@K, MRR, NDCG@K.
//
// cargo run --bin run_agent -- eval

use std::collections::HashSet;

use anyhow::Result;
use serde::Serialize;

use crate::{Document, RAGEngine};

// ── Types ──────────────────────────────────────────────────────────────────────
pub struct EvalCase {
    pub query:       String,
    pub relevant_ids: HashSet<String>,
    pub description: String,
}

#[derive(Debug, Serialize)]
pub struct EvalResult {
    pub query:          String,
    pub precision_at_k: f64,
    pub recall_at_k:    f64,
    pub reciprocal_rank: f64,
    pub ndcg_at_k:      f64,
    pub retrieved_ids:  Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct EvalReport {
    pub top_k:          u64,
    pub num_cases:      usize,
    pub mean_precision: f64,
    pub mean_recall:    f64,
    pub mean_mrr:       f64,
    pub mean_ndcg:      f64,
    pub per_case:       Vec<EvalResult>,
}

// ── Metrics ────────────────────────────────────────────────────────────────────
fn precision_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 { return 0.0; }
    let hits = retrieved.iter().take(k).filter(|id| relevant.contains(*id)).count();
    hits as f64 / k as f64
}

fn recall_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if relevant.is_empty() { return 0.0; }
    let hits = retrieved.iter().take(k).filter(|id| relevant.contains(*id)).count();
    hits as f64 / relevant.len() as f64
}

fn reciprocal_rank(retrieved: &[String], relevant: &HashSet<String>) -> f64 {
    for (i, id) in retrieved.iter().enumerate() {
        if relevant.contains(id) {
            return 1.0 / (i + 1) as f64;
        }
    }
    0.0
}

fn ndcg_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    let dcg = |ids: &[String]| -> f64 {
        ids.iter().take(k).enumerate().map(|(i, id)| {
            if relevant.contains(id) { 1.0 / (i as f64 + 2.0).log2() } else { 0.0 }
        }).sum()
    };
    let actual   = dcg(retrieved);
    let ideal: Vec<String> = relevant.iter().take(k).cloned().collect();
    let ideal_dcg = dcg(&ideal);
    if ideal_dcg == 0.0 { 0.0 } else { actual / ideal_dcg }
}

// ── Evaluator ──────────────────────────────────────────────────────────────────
pub struct RAGEvaluator<'a> {
    engine: &'a RAGEngine,
    top_k:  u64,
}

impl<'a> RAGEvaluator<'a> {
    pub fn new(engine: &'a RAGEngine, top_k: u64) -> Self {
        Self { engine, top_k }
    }

    pub async fn evaluate_case(&self, case: &EvalCase) -> Result<EvalResult> {
        let chunks = self.engine.retrieve(&case.query, self.top_k).await?;
        let ids: Vec<String> = chunks.iter().map(|c| c.doc_id.clone()).collect();
        let k = self.top_k as usize;
        Ok(EvalResult {
            query:           case.query.clone(),
            precision_at_k:  precision_at_k(&ids, &case.relevant_ids, k),
            recall_at_k:     recall_at_k(&ids, &case.relevant_ids, k),
            reciprocal_rank: reciprocal_rank(&ids, &case.relevant_ids),
            ndcg_at_k:       ndcg_at_k(&ids, &case.relevant_ids, k),
            retrieved_ids:   ids,
        })
    }

    pub async fn evaluate(&self, cases: &[EvalCase]) -> Result<EvalReport> {
        let mut results = Vec::new();
        for case in cases {
            results.push(self.evaluate_case(case).await?);
        }
        let n = results.len() as f64;
        let (mut sp, mut sr, mut sm, mut sn) = (0.0, 0.0, 0.0, 0.0);
        for r in &results {
            sp += r.precision_at_k;
            sr += r.recall_at_k;
            sm += r.reciprocal_rank;
            sn += r.ndcg_at_k;
        }
        Ok(EvalReport {
            top_k:          self.top_k,
            num_cases:      results.len(),
            mean_precision: if n > 0.0 { sp / n } else { 0.0 },
            mean_recall:    if n > 0.0 { sr / n } else { 0.0 },
            mean_mrr:       if n > 0.0 { sm / n } else { 0.0 },
            mean_ndcg:      if n > 0.0 { sn / n } else { 0.0 },
            per_case:       results,
        })
    }
}

impl EvalReport {
    pub fn print_summary(&self) {
        println!("\n{}", "=".repeat(50));
        println!("RAG Eval (Rust)  top_k={}  n={}", self.top_k, self.num_cases);
        println!("{}", "=".repeat(50));
        println!("  Mean Precision@{}: {:.4}", self.top_k, self.mean_precision);
        println!("  Mean Recall@{}:    {:.4}", self.top_k, self.mean_recall);
        println!("  Mean MRR:          {:.4}", self.mean_mrr);
        println!("  Mean NDCG@{}:      {:.4}", self.top_k, self.mean_ndcg);
        println!();
        for r in &self.per_case {
            let status = if r.precision_at_k > 0.0 { "✅" } else { "❌" };
            println!("  {} [P={:.2} R={:.2} MRR={:.2}]  {}",
                status, r.precision_at_k, r.recall_at_k, r.reciprocal_rank,
                &r.query[..r.query.len().min(60)]);
        }
    }
}

// ── Demo data ──────────────────────────────────────────────────────────────────
pub fn eval_demo_docs() -> Vec<Document> {
    vec![
        Document { content: "Claude is an AI assistant made by Anthropic.".to_string(), metadata: [("source".to_string(), "anthropic".to_string())].into(), doc_id: None },
        Document { content: "RAG combines retrieval with generation to ground LLM answers.".to_string(), metadata: [("source".to_string(), "rag_paper".to_string())].into(), doc_id: None },
        Document { content: "Qdrant is a high-performance vector database written in Rust.".to_string(), metadata: [("source".to_string(), "qdrant".to_string())].into(), doc_id: None },
        Document { content: "Voyage AI provides state-of-the-art embedding and reranking models.".to_string(), metadata: [("source".to_string(), "voyage".to_string())].into(), doc_id: None },
        Document { content: "Rust is a systems programming language focused on safety and performance.".to_string(), metadata: [("source".to_string(), "rust_docs".to_string())].into(), doc_id: None },
    ]
}

pub async fn run_eval_cli(top_k: u64) -> Result<()> {
    let engine = RAGEngine::new("eval_rust").await?;
    let docs   = eval_demo_docs();
    engine.ingest(docs.clone()).await?;

    let cases: Vec<EvalCase> = docs.iter().map(|d| {
        let source = d.metadata["source"].clone();
        EvalCase {
            query:        format!("Tell me about {}", source),
            relevant_ids: [d.doc_id.clone().unwrap_or_default()].into(),
            description:  source,
        }
    }).collect();

    let evaluator = RAGEvaluator::new(&engine, top_k);
    let report    = evaluator.evaluate(&cases).await?;
    report.print_summary();
    println!("\n{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_precision_at_k() {
        let retrieved = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let relevant: HashSet<String> = ["a".to_string(), "c".to_string()].into();
        assert!((precision_at_k(&retrieved, &relevant, 3) - 2.0/3.0).abs() < 1e-9);
        assert!((precision_at_k(&retrieved, &relevant, 1) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_recall_at_k() {
        let retrieved = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let relevant: HashSet<String> = ["a".to_string(), "c".to_string(), "d".to_string()].into();
        assert!((recall_at_k(&retrieved, &relevant, 3) - 2.0/3.0).abs() < 1e-9);
    }

    #[test]
    fn test_reciprocal_rank() {
        let retrieved = vec!["x".to_string(), "a".to_string()];
        let relevant: HashSet<String> = ["a".to_string()].into();
        assert!((reciprocal_rank(&retrieved, &relevant) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_reciprocal_rank_miss() {
        let retrieved = vec!["x".to_string()];
        let relevant: HashSet<String> = ["a".to_string()].into();
        assert_eq!(reciprocal_rank(&retrieved, &relevant), 0.0);
    }
}
