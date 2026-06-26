//! RAG agent CLI. Library code lives in src/rag_agent.rs.
//! Run with: cargo run --bin rag_agent_cli -- --task "your question" [--dir ./docs] [--max-iterations 30] [--quiet]

use anyhow::Result;
use rag_ai_rust::rag_agent::run_agent_cli;

#[tokio::main]
async fn main() -> Result<()> {
    run_agent_cli().await
}
