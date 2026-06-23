//! Production Runtime Harness — Rust
//! Wires react_loop.rs into a fully runnable CLI agent.
//!
//! Same Cargo.toml deps as react_loop.rs, plus:
//!   clap = { version = "4", features = ["derive"] }
//!
//! Usage:
//!   cargo run -- "your task here"
//!   cargo run -- --system "You are a DevOps expert." "audit /tmp"
//!   cargo run -- --max-iter 50 --json-out /tmp/result.json "task"
//!   echo "task" | cargo run -- -
//!
//! Environment:
//!   ANTHROPIC_API_KEY   required
//!   AGENT_MAX_ITER      default 30
//!   AGENT_SYSTEM        system prompt override

use std::env;
use std::fs;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use clap::Parser;
use serde_json::json;

// Include engine (in a real project: mod react_loop; use react_loop::*)
// For single-file: compile both files together or use mod.
use crate::{run_react, ReactOptions, ToolRegistry, Step, Trace};

// ── CLI args ──────────────────────────────────────────────────────────────────
#[derive(Parser, Debug)]
#[command(name = "run_agent", about = "Production ReAct Agent Runtime Harness")]
struct Args {
    /// Task to execute, or '-' to read from stdin
    #[arg(default_value = "-")]
    task: String,

    /// Additional system prompt
    #[arg(long, default_value = "")]
    system: String,

    /// Maximum iterations
    #[arg(long, default_value_t = 30)]
    max_iter: usize,

    /// Write result JSON to this path
    #[arg(long)]
    json_out: Option<String>,

    /// Suppress step-by-step output
    #[arg(long)]
    quiet: bool,
}

// ── Validate environment ──────────────────────────────────────────────────────
fn validate_env() {
    let key = env::var("ANTHROPIC_API_KEY").unwrap_or_default();
    if key.trim().is_empty() {
        eprintln!("[harness] ERROR: ANTHROPIC_API_KEY is not set");
        std::process::exit(1);
    }
    if !key.trim_start().starts_with("sk-ant-") {
        eprintln!("[harness] WARN: ANTHROPIC_API_KEY does not look like a valid Anthropic key");
    }
}

// ── Step printer ──────────────────────────────────────────────────────────────
fn make_step_printer(verbose: bool, interrupted: Arc<AtomicBool>) -> Option<Box<dyn Fn(&Step) + Send>> {
    if !verbose { return None; }
    Some(Box::new(move |step: &Step| {
        if interrupted.load(Ordering::Relaxed) {
            eprintln!("[harness] Agent interrupted");
            std::process::exit(130);
        }
        match step {
            Step::Thought { content } => {
                println!("\n\x1b[94m💭 THOUGHT\x1b[0m\n{}", content);
            }
            Step::Action { tool, input } => {
                let inp = serde_json::to_string_pretty(input).unwrap_or_default();
                println!("\n\x1b[93m⚡ ACTION\x1b[0m  {}\n{}", tool, inp);
            }
            Step::Observation { content, error } => {
                let (color, label) = if *error {
                    ("\x1b[91m", "❌ ERROR")
                } else {
                    ("\x1b[92m", "👁 OBSERVE")
                };
                let preview: String = content.chars().take(600).collect();
                let suffix = if content.len() > 600 { "..." } else { "" };
                println!("\n{}{}\x1b[0m\n{}{}", color, label, preview, suffix);
            }
            _ => {}
        }
    }))
}

// ── Main ──────────────────────────────────────────────────────────────────────
#[tokio::main]
async fn main() -> Result<()> {
    validate_env();

    let mut args = Args::parse();

    // Override from env
    if let Ok(v) = env::var("AGENT_MAX_ITER") {
        if let Ok(n) = v.parse::<usize>() { args.max_iter = n; }
    }
    if let Ok(s) = env::var("AGENT_SYSTEM") {
        if args.system.is_empty() { args.system = s; }
    }

    // Read task
    let task = if args.task == "-" {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        buf.trim().to_string()
    } else {
        args.task.trim().to_string()
    };

    if task.is_empty() {
        eprintln!("[harness] ERROR: no task provided");
        std::process::exit(1);
    }

    eprintln!("[harness] Task: {}", &task[..task.len().min(200)]);
    eprintln!("[harness] Max iterations: {}", args.max_iter);

    // Signal handling
    let interrupted = Arc::new(AtomicBool::new(false));
    let interrupted_clone = interrupted.clone();
    ctrlc::set_handler(move || {
        if interrupted_clone.load(Ordering::Relaxed) {
            eprintln!("[harness] Force quit");
            std::process::exit(130);
        }
        interrupted_clone.store(true, Ordering::Relaxed);
        eprintln!("[harness] Interrupt — finishing current iteration...");
    }).ok();

    let registry = ToolRegistry::new();
    let start = Instant::now();

    let result = run_react(&task, &registry, ReactOptions {
        system_extra:   args.system.clone(),
        max_iterations: args.max_iter,
        on_step:        make_step_printer(!args.quiet, interrupted.clone()),
    }).await;

    let elapsed_ms = start.elapsed().as_millis();

    match result {
        Ok((answer, trace)) => {
            let sep = "=".repeat(64);
            println!("\n{}\nFINAL ANSWER\n{}\n{}\n{}", sep, sep, answer, sep);
            println!("Iterations: {} | Tokens: {} | Time: {}ms",
                trace.iterations, trace.total_tokens, elapsed_ms);

            if let Some(json_path) = &args.json_out {
                let doc = json!({
                    "task":         task,
                    "answer":       answer,
                    "iterations":   trace.iterations,
                    "total_tokens": trace.total_tokens,
                    "elapsed_ms":   elapsed_ms,
                    "steps":        trace.steps,
                });
                fs::write(json_path, serde_json::to_string_pretty(&doc)?)?;
                eprintln!("[harness] Result written to {}", json_path);
            }

            Ok(())
        }
        Err(e) => {
            if interrupted.load(Ordering::Relaxed) {
                eprintln!("[harness] Agent stopped by user");
                std::process::exit(130);
            }
            eprintln!("[harness] ERROR: {}", e);
            std::process::exit(1);
        }
    }
}
