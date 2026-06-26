//! Trading research agent CLI. Library code lives in src/trading_agent.rs.
//! Run with: cargo run --bin trading_agent_cli -- --task "Backtest SMA crossover on AAPL" [--max-iterations 20] [--skip-ingest]

use anyhow::Result;
use rag_ai_rust::trading_agent::run_trading_agent_cli;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut task = "Search the knowledge base for momentum strategies, then explain how a 50/200 SMA crossover works and what its main risk is.".to_string();
    let mut max_iterations = 20usize;
    let mut skip_ingest = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--task" => { if i + 1 < args.len() { task = args[i + 1].clone(); i += 1; } }
            "--max-iterations" => { if i + 1 < args.len() { max_iterations = args[i + 1].parse().unwrap_or(20); i += 1; } }
            "--skip-ingest" => { skip_ingest = true; }
            _ => {}
        }
        i += 1;
    }

    run_trading_agent_cli(&task, max_iterations, skip_ingest).await
}
