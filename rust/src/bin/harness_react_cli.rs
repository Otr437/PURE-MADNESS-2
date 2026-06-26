//! ReAct test harness runner. Library code lives in src/harness_react.rs.
//! Run with: cargo run --bin harness_react_cli
//! Exits with status 1 if any harness test fails.

use rag_ai_rust::harness_react::run_harness;

#[tokio::main]
async fn main() {
    if let Err(e) = run_harness().await {
        eprintln!("HARNESS FAILED: {}", e);
        std::process::exit(1);
    }
}
