//! RAG REST API server. Library code lives in src/rag_api.rs.
//! Run with: cargo run --bin rag_api_server
//! Requires: JWT_SECRET, PORT (default 8003), QDRANT_URL, ANTHROPIC_API_KEY (or provider equivalent)

use anyhow::Result;
use rag_ai_rust::rag_api::start_api_server;

#[tokio::main]
async fn main() -> Result<()> {
    start_api_server().await
}
