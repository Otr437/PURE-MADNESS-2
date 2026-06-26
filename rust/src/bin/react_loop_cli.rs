//! CLI for the bare ReAct loop (no RAG). Library code lives in src/react_loop.rs.
//! Run with: cargo run --bin react_loop_cli -- "your task here"

use std::env;

use anyhow::Result;
use rag_ai_rust::react_loop::{run_react, ReactOptions, Step, ToolRegistry};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let task = if args.is_empty() {
        "Calculate the 47th Fibonacci number using bash, then explain the result.".to_string()
    } else {
        args.join(" ")
    };

    let registry = ToolRegistry::new();
    let (answer, trace) = run_react(&task, &registry, ReactOptions {
        on_step: Some(Box::new(|step| match step {
            Step::Thought { content }            => println!("\n💭 THOUGHT: {}", &content[..content.len().min(300)]),
            Step::Action { tool, input }         => println!("\n⚡ ACTION: {}({})", tool, input.to_string().chars().take(200).collect::<String>()),
            Step::Observation { content, error } => println!("\n{} OBSERVE: {}", if *error { "❌" } else { "👁" }, &content[..content.len().min(300)]),
            _ => {}
        })),
        ..Default::default()
    }).await?;

    println!("\n{}", "=".repeat(60));
    println!("FINAL ANSWER:\n{}", answer);
    println!("{}", "=".repeat(60));
    println!("Iterations: {} | Tokens: {} | Time: {}ms", trace.iterations, trace.total_tokens, trace.elapsed_ms);
    println!("\nFull trace:\n{}", serde_json::to_string_pretty(&trace.steps)?);
    Ok(())
}
