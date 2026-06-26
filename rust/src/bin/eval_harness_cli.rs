//! Retrieval quality evaluation CLI. Library code lives in src/eval_harness.rs.
//! Run with: cargo run --bin eval_harness_cli

use anyhow::Result;
use rag_ai_rust::eval_harness::run_eval_cli;

#[tokio::main]
async fn main() -> Result<()> {
    run_eval_cli(5).await
}
