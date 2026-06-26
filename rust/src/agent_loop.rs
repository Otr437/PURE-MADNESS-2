// Plug-and-play Agentic Loop — Rust
// Multi-provider via ModelRouter (Claude / DeepSeek / OpenAI).
// All tools are real implementations from ToolRegistry — no stubs.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// cargo run --bin run_agent -- agent --task "your question"

use std::env;
use anyhow::Result;
use serde_json::json;

use crate::{ModelRouter, ContentBlock, ToolRegistry, make_tool_result_message};

/// Minimal single-shot agentic loop using ModelRouter + ToolRegistry.
/// For multi-step ReAct behaviour with Thought/Act/Observe, use `run_react()` instead.
pub async fn agent_loop(
    user_message: &str,
    max_iterations: usize,
    system: Option<&str>,
) -> Result<String> {
    let router   = ModelRouter::new(None, None)?;
    let registry = ToolRegistry::new();
    let schemas  = registry.schemas();

    let mut messages: Vec<serde_json::Value> = vec![
        json!({ "role": "user", "content": user_message })
    ];

    eprintln!("[agent_loop] provider={} model={}", router.provider, router.model);

    for i in 0..max_iterations {
        eprintln!("[agent_loop] iteration {}", i + 1);

        let resp = router.create(
            &messages,
            Some(&schemas),
            system,
            4096,
        ).await?;

        messages.push(resp.to_assistant_message());

        if resp.stop_reason == "end_turn" {
            for block in &resp.content {
                if let ContentBlock::Text { text } = block {
                    let t = text.trim().to_string();
                    if !t.is_empty() {
                        return Ok(t);
                    }
                }
            }
        }

        if resp.stop_reason == "tool_use" {
            let mut tool_results: Vec<serde_json::Value> = Vec::new();

            for block in &resp.content {
                if let ContentBlock::ToolUse { id, name, input } = block {
                    // finish tool — extract answer and return immediately
                    if name == "finish" {
                        let answer = input.get("answer")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        return Ok(answer);
                    }

                    let input_val = serde_json::json!(input);
                    eprintln!("[agent_loop] ⚡ {}({})",
                        name,
                        &input_val.to_string()[..input_val.to_string().len().min(120)]);

                    let (result, is_error) = match registry.call(name, input_val) {
                        Ok(r)  => (r, false),
                        Err(e) => {
                            eprintln!("[agent_loop] ❌ {}: {}", name, e);
                            (format!("Tool error ({}): {}", name, e), true)
                        }
                    };

                    eprintln!("[agent_loop] 👁 {}", &result[..result.len().min(120)]);
                    tool_results.push(make_tool_result_message(id, &result, is_error));
                }
            }

            // Flatten tool results into a single user message with content array
            let content: Vec<serde_json::Value> = tool_results.into_iter().flat_map(|msg| {
                msg["content"].as_array().cloned().unwrap_or_default()
            }).collect();
            messages.push(json!({ "role": "user", "content": content }));
            continue;
        }

        eprintln!("[agent_loop] unexpected stop_reason: {}", resp.stop_reason);
        break;
    }

    anyhow::bail!("AgentLoop did not finish within {} iterations", max_iterations)
}

/// Demo task runner — call from a binary's #[tokio::main] async fn main().
pub async fn agent_loop_demo() -> Result<String> {
    let task = "Use bash to find the current date and time, then report it.";
    eprintln!("[agent_loop_demo] task: {}", task);
    agent_loop(task, 10, Some("You are a helpful assistant. Use provided tools to complete tasks.")).await
}
