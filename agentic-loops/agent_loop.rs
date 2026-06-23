// Plug-and-play Agentic Loop — Rust
// Cargo.toml deps:
//   reqwest = { version = "0.12", features = ["json"] }
//   tokio = { version = "1", features = ["full"] }
//   serde = { version = "1", features = ["derive"] }
//   serde_json = "1"
// Set: ANTHROPIC_API_KEY env var

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MODEL: &str = "claude-opus-4-6";

// ── Message types ─────────────────────────────────────────────────────────────
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Message {
    role: String,
    content: Value, // string or array of blocks
}

// ── Execute tools here ────────────────────────────────────────────────────────
fn execute_tool(name: &str, input: &Value) -> String {
    match name {
        "get_weather" => {
            let city = input["city"].as_str().unwrap_or("unknown");
            format!("The weather in {} is 72°F and sunny.", city) // stub
        }
        _ => "Unknown tool".to_string(),
    }
}

// ── The loop ──────────────────────────────────────────────────────────────────
async fn run_agent(user_message: &str, max_iterations: usize) -> Result<String, Box<dyn std::error::Error>> {
    let api_key = env::var("ANTHROPIC_API_KEY")?;
    let client = Client::new();

    let tools = json!([{
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": { "type": "string", "description": "City name" }
            },
            "required": ["city"]
        }
    }]);

    let mut messages: Vec<Message> = vec![Message {
        role: "user".to_string(),
        content: json!(user_message),
    }];

    for _ in 0..max_iterations {
        let body = json!({
            "model": MODEL,
            "max_tokens": 1024,
            "tools": tools,
            "messages": messages
        });

        let resp: Value = client
            .post(API_URL)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let stop_reason = resp["stop_reason"].as_str().unwrap_or("");
        let content = resp["content"].clone();

        messages.push(Message {
            role: "assistant".to_string(),
            content: content.clone(),
        });

        if stop_reason == "end_turn" {
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    if block["type"] == "text" {
                        return Ok(block["text"].as_str().unwrap_or("").to_string());
                    }
                }
            }
        }

        if stop_reason == "tool_use" {
            let mut tool_results = vec![];
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    if block["type"] == "tool_use" {
                        let name = block["name"].as_str().unwrap_or("");
                        let input = &block["input"];
                        let result = execute_tool(name, input);
                        println!("[Tool] {} → {}", name, result);
                        tool_results.push(json!({
                            "type": "tool_result",
                            "tool_use_id": block["id"],
                            "content": result
                        }));
                    }
                }
            }
            messages.push(Message {
                role: "user".to_string(),
                content: json!(tool_results),
            });
        }
    }

    Ok("Max iterations reached.".to_string())
}

#[tokio::main]
async fn main() {
    match run_agent("What's the weather like in Tokyo?", 10).await {
        Ok(result) => println!("{}", result),
        Err(e) => eprintln!("Error: {}", e),
    }
}
