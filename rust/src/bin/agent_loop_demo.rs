//! Demo binary for the agentic loop. Library code lives in src/agent_loop.rs.
//! Run with: cargo run --bin agent_loop_demo

use anyhow::Result;
use rag_ai_rust::agent_loop::agent_loop_demo;

#[tokio::main]
async fn main() -> Result<()> {
    let answer = agent_loop_demo().await?;
    println!("{}", answer);
    Ok(())
}
