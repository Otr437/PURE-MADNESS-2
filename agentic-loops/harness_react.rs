//! Test Harness — Rust ReAct Loop
//! Runs a battery of tasks, captures full traces, reports pass/fail/tokens/time.
//!
//! Add to Cargo.toml (same deps as react_loop.rs, plus):
//!   tokio = { version = "1", features = ["full"] }
//!
//! export ANTHROPIC_API_KEY=sk-ant-...
//! cargo run --bin harness

// Include the engine (in a real project, put react_loop in lib.rs and import it)
// For single-file builds: paste react_loop.rs contents above this file.
// Here we import the public API directly.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::time::Instant;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::json;

// Import from react_loop (assumes same crate / mod)
use crate::{run_react, ReactOptions, ToolRegistry, Step, Trace};

// ── Types ─────────────────────────────────────────────────────────────────────

type ValidatorFn = Box<dyn Fn(&str, &Trace) -> (bool, String) + Send + Sync>;

struct TestCase {
    name:           &'static str,
    task:           &'static str,
    validate:       ValidatorFn,
    max_iterations: usize,
    system_extra:   &'static str,
}

#[derive(Debug, Serialize)]
struct TestResult {
    name:         String,
    passed:       bool,
    reason:       String,
    answer:       String,
    iterations:   usize,
    total_tokens: u64,
    elapsed_ms:   u128,
    error:        String,
}

// ── Validators ────────────────────────────────────────────────────────────────

fn contains(keywords: Vec<&'static str>) -> ValidatorFn {
    Box::new(move |answer: &str, _: &Trace| {
        let lower = answer.to_lowercase();
        for k in &keywords {
            if !lower.contains(&k.to_lowercase()[..]) {
                return (false, format!("missing keyword: {:?}", k));
            }
        }
        (true, "OK".into())
    })
}

fn answer_not_empty() -> ValidatorFn {
    Box::new(|answer: &str, _: &Trace| {
        if answer.trim().is_empty() {
            (false, "answer is empty".into())
        } else {
            (true, "OK".into())
        }
    })
}

fn used_tool(tool_names: Vec<&'static str>) -> ValidatorFn {
    Box::new(move |_: &str, trace: &Trace| {
        let used: std::collections::HashSet<&str> = trace.steps.iter()
            .filter_map(|s| if let Step::Action { tool, .. } = s { Some(tool.as_str()) } else { None })
            .collect();
        for t in &tool_names {
            if !used.contains(*t) {
                return (false, format!("tool {:?} was never called", t));
            }
        }
        (true, "OK".into())
    })
}

fn thought_before_action() -> ValidatorFn {
    Box::new(|_: &str, trace: &Trace| {
        let mut last_was_thought = false;
        for step in &trace.steps {
            match step {
                Step::Thought { .. } => last_was_thought = true,
                Step::Action { tool, .. } if tool != "think" && tool != "finish" => {
                    if !last_was_thought {
                        return (false, format!("action {:?} not preceded by thought", tool));
                    }
                    last_was_thought = false;
                }
                _ => {}
            }
        }
        (true, "OK".into())
    })
}

fn min_iterations(n: usize) -> ValidatorFn {
    Box::new(move |_: &str, trace: &Trace| {
        if trace.iterations < n {
            (false, format!("expected >= {} iterations, got {}", n, trace.iterations))
        } else {
            (true, "OK".into())
        }
    })
}

fn all(validators: Vec<ValidatorFn>) -> ValidatorFn {
    Box::new(move |answer: &str, trace: &Trace| {
        for v in &validators {
            let (ok, reason) = v(answer, trace);
            if !ok { return (false, reason); }
        }
        (true, "OK".into())
    })
}

// ── Test suite ────────────────────────────────────────────────────────────────

fn build_suite() -> Vec<TestCase> {
    vec![
        TestCase {
            name: "basic_answer",
            task: "What is 2 + 2? Use the think tool to reason, then finish.",
            validate: all(vec![contains(vec!["4"]), thought_before_action()]),
            max_iterations: 10,
            system_extra: "",
        },
        TestCase {
            name: "code_execution",
            task: "Write and run a bash command to compute the sum of squares from 1 to 10. Report the result.",
            validate: all(vec![contains(vec!["385"]), used_tool(vec!["run_bash"]), thought_before_action()]),
            max_iterations: 15,
            system_extra: "",
        },
        TestCase {
            name: "file_write_and_read",
            task: "Write 'ReAct harness test' to /tmp/harness_test_rs.txt, then read it back and confirm the content.",
            validate: all(vec![
                contains(vec!["ReAct harness test"]),
                used_tool(vec!["write_file", "read_file"]),
                thought_before_action(),
            ]),
            max_iterations: 15,
            system_extra: "",
        },
        TestCase {
            name: "multi_step_reasoning",
            task: "Calculate the 10th Fibonacci number using bash. Then the 20th. Report the ratio of 20th to 10th.",
            validate: all(vec![
                contains(vec!["55", "6765"]),
                used_tool(vec!["run_bash"]),
                min_iterations(3),
                thought_before_action(),
            ]),
            max_iterations: 20,
            system_extra: "",
        },
        TestCase {
            name: "error_recovery",
            task: "Try to read /tmp/no_such_file_rs_99.txt. If it fails, create it with 'created by agent', then read it back.",
            validate: all(vec![
                contains(vec!["created by agent"]),
                used_tool(vec!["read_file", "write_file"]),
                thought_before_action(),
            ]),
            max_iterations: 15,
            system_extra: "",
        },
        TestCase {
            name: "system_prompt_respected",
            task: "Tell me your name.",
            validate: contains(vec!["ARIA"]),
            max_iterations: 10,
            system_extra: "Your name is ARIA. Always introduce yourself as ARIA.",
        },
        TestCase {
            name: "finish_called",
            task: "Say hello and finish.",
            validate: all(vec![answer_not_empty(), thought_before_action()]),
            max_iterations: 10,
            system_extra: "",
        },
    ]
}

// ── Runner ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let suite = build_suite();
    let mut results: Vec<TestResult> = Vec::new();

    println!("\n{}", "=".repeat(64));
    println!("  ReAct Harness — Rust — {} tests", suite.len());
    println!("{}\n", "=".repeat(64));

    let registry = ToolRegistry::new();

    for tc in &suite {
        print!("▶  {:<40} ... ", tc.name);

        let start = Instant::now();
        let mut result = TestResult {
            name:         tc.name.to_string(),
            passed:       false,
            reason:       String::new(),
            answer:       String::new(),
            iterations:   0,
            total_tokens: 0,
            elapsed_ms:   0,
            error:        String::new(),
        };

        match run_react(tc.task, &registry, ReactOptions {
            system_extra:   tc.system_extra.to_string(),
            max_iterations: tc.max_iterations,
            on_step:        None,
        }).await {
            Ok((answer, trace)) => {
                result.answer       = answer.clone();
                result.iterations   = trace.iterations;
                result.total_tokens = trace.total_tokens;
                result.elapsed_ms   = trace.elapsed_ms;

                let (ok, reason) = (tc.validate)(&answer, &trace);
                result.passed = ok;
                result.reason = reason;
            }
            Err(e) => {
                result.passed    = false;
                result.reason    = "Exception".into();
                result.error     = e.to_string();
                result.elapsed_ms = start.elapsed().as_millis();
            }
        }

        let status = if result.passed { "✅ PASS" } else { "❌ FAIL" };
        println!("{}  ({}ms, {} tok, {} iter)",
            status, result.elapsed_ms, result.total_tokens, result.iterations);

        if !result.passed {
            println!("   Reason : {}", result.reason);
            if !result.error.is_empty() {
                println!("   Error  : {}", &result.error[..result.error.len().min(300)]);
            }
            if !result.answer.is_empty() {
                println!("   Answer : {}", &result.answer[..result.answer.len().min(200)]);
            }
        }

        results.push(result);
    }

    // Summary
    let passed       = results.iter().filter(|r| r.passed).count();
    let total_tokens: u64  = results.iter().map(|r| r.total_tokens).sum();
    let total_ms: u128     = results.iter().map(|r| r.elapsed_ms).sum();

    println!("\n{}", "=".repeat(64));
    println!("  Results : {}/{} passed", passed, results.len());
    println!("  Tokens  : {}", total_tokens);
    println!("  Time    : {:.2}s", total_ms as f64 / 1000.0);
    println!("{}\n", "=".repeat(64));

    let report_path = "/tmp/react_harness_report_rs.json";
    let json = serde_json::to_string_pretty(&results)?;
    fs::write(report_path, json)?;
    println!("  Report  → {}", report_path);

    if passed < results.len() {
        std::process::exit(1);
    }
    Ok(())
}
