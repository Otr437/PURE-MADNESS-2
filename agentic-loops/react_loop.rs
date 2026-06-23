//! Production ReAct Loop — Rust
//! Reason → Act → Observe, repeat until finish() called.
//!
//! Cargo.toml:
//! [dependencies]
//! reqwest = { version = "0.12", features = ["json", "blocking"] }
//! tokio = { version = "1", features = ["full"] }
//! serde = { version = "1", features = ["derive"] }
//! serde_json = "1"
//! anyhow = "1"
//!
//! export ANTHROPIC_API_KEY=sk-ant-...
//! cargo run -- "your task here"

use std::collections::HashMap;
use std::env;
use std::fs;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Trace types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    Thought { content: String },
    Action { tool: String, input: Value },
    Observation { content: String, error: bool },
    Answer { content: String },
}

#[derive(Debug, Default, Serialize)]
pub struct Trace {
    pub steps:        Vec<Step>,
    pub total_tokens: u64,
    pub iterations:   usize,
    pub elapsed_ms:   u128,
}

// ── Tool registry ─────────────────────────────────────────────────────────────

type ToolFn = Arc<dyn Fn(Value) -> Result<String> + Send + Sync>;

#[derive(Clone)]
pub struct ToolDef {
    pub name:        String,
    pub description: String,
    pub schema:      Value,
    pub func:        ToolFn,
}

pub struct ToolRegistry {
    tools: HashMap<String, ToolDef>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        let mut r = Self { tools: HashMap::new() };
        r.register_defaults();
        r
    }

    pub fn register(&mut self, name: &str, description: &str, schema: Value, func: ToolFn) {
        self.tools.insert(name.to_string(), ToolDef {
            name:        name.to_string(),
            description: description.to_string(),
            schema,
            func,
        });
    }

    pub fn schemas(&self) -> Vec<Value> {
        self.tools.values().map(|t| json!({
            "name":         t.name,
            "description":  t.description,
            "input_schema": t.schema,
        })).collect()
    }

    pub fn call(&self, name: &str, input: Value) -> Result<String> {
        let def = self.tools.get(name)
            .ok_or_else(|| anyhow!("Tool '{}' not registered", name))?;
        (def.func)(input)
    }

    fn register_defaults(&mut self) {
        self.register("think",
            "Reason step by step before acting.",
            json!({
                "type": "object",
                "properties": { "reasoning": { "type": "string" } },
                "required": ["reasoning"]
            }),
            Arc::new(|_| Ok("OK".to_string())),
        );

        self.register("search",
            "Search the web for current information.",
            json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
            Arc::new(|input| {
                // Replace with Brave, Tavily, SerpAPI, etc.
                Err(anyhow!("Search not wired up. query: {}", input["query"]))
            }),
        );

        self.register("fetch_url",
            "Fetch the text content of a URL.",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }),
            Arc::new(|input| {
                let url = input["url"].as_str().unwrap_or("").to_string();
                let body = reqwest::blocking::get(&url)
                    .context("HTTP GET failed")?
                    .text()
                    .context("Read body failed")?;
                // Strip HTML tags (simple regex-free approach)
                let mut result = String::new();
                let mut in_tag = false;
                for c in body.chars() {
                    match c {
                        '<' => in_tag = true,
                        '>' => in_tag = false,
                        _ if !in_tag => result.push(c),
                        _ => {}
                    }
                }
                let clean: String = result.split_whitespace().collect::<Vec<_>>().join(" ");
                Ok(clean.chars().take(8000).collect())
            }),
        );

        self.register("run_bash",
            "Execute a bash command. Returns stdout/stderr. Timeout 15s.",
            json!({
                "type": "object",
                "properties": { "command": { "type": "string" } },
                "required": ["command"]
            }),
            Arc::new(|input| {
                let command = input["command"].as_str().unwrap_or("").to_string();
                let output = Command::new("bash")
                    .args(["-c", &command])
                    .output()
                    .context("Failed to run bash")?;
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let combined = format!("{}{}", stdout, stderr).trim().to_string();
                if combined.is_empty() {
                    return Ok("(no output)".to_string());
                }
                Ok(combined.chars().take(8000).collect())
            }),
        );

        self.register("read_file",
            "Read a file from disk.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
            Arc::new(|input| {
                let path = input["path"].as_str().unwrap_or("").to_string();
                fs::read_to_string(&path).context("Read file failed")
            }),
        );

        self.register("write_file",
            "Write content to a file on disk.",
            json!({
                "type": "object",
                "properties": {
                    "path":    { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
            Arc::new(|input| {
                let path    = input["path"].as_str().unwrap_or("").to_string();
                let content = input["content"].as_str().unwrap_or("").to_string();
                let len = content.len();
                fs::write(&path, &content).context("Write file failed")?;
                Ok(format!("Written {} bytes to {}", len, path))
            }),
        );

        self.register("finish",
            "Call when you have the final answer. Ends the loop.",
            json!({
                "type": "object",
                "properties": { "answer": { "type": "string" } },
                "required": ["answer"]
            }),
            Arc::new(|input| Ok(input["answer"].as_str().unwrap_or("").to_string())),
        );
    }
}

// ── API types ─────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct ApiResponse {
    content:     Vec<ContentBlock>,
    stop_reason: String,
    usage:       Usage,
}

#[derive(Deserialize, Debug)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind:  String,
    text:  Option<String>,
    id:    Option<String>,
    name:  Option<String>,
    input: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct Usage {
    input_tokens:  u64,
    output_tokens: u64,
}

// ── ReAct system prompt ───────────────────────────────────────────────────────

const REACT_SYSTEM: &str = "You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).\n\n\
For every task:\n\
1. Use the think tool to reason about what to do next before acting.\n\
2. Call the appropriate tool to act.\n\
3. Observe the result and reason again.\n\
4. Repeat until you have a complete, verified answer.\n\
5. Call finish with your final answer when done.\n\n\
Rules:\n\
- Always think before acting. Never skip the think step.\n\
- If a tool errors, reason about why and try a different approach.\n\
- Do not guess. If unsure, search or fetch.\n\
- Be thorough. Do not call finish until the task is fully complete.";

// ── Core ReAct engine ─────────────────────────────────────────────────────────

pub struct ReactOptions {
    pub system_extra:   String,
    pub max_iterations: usize,
    pub on_step:        Option<Box<dyn Fn(&Step) + Send>>,
}

impl Default for ReactOptions {
    fn default() -> Self {
        Self {
            system_extra:   String::new(),
            max_iterations: 30,
            on_step:        None,
        }
    }
}

pub async fn run_react(
    task: &str,
    registry: &ToolRegistry,
    opts: ReactOptions,
) -> Result<(String, Trace)> {
    let api_key = env::var("ANTHROPIC_API_KEY").context("ANTHROPIC_API_KEY not set")?;
    let http    = Client::builder().timeout(std::time::Duration::from_secs(60)).build()?;

    let system = if opts.system_extra.is_empty() {
        REACT_SYSTEM.to_string()
    } else {
        format!("{}\n\n{}", REACT_SYSTEM, opts.system_extra)
    };

    let mut messages: Vec<Value> = vec![json!({ "role": "user", "content": task })];
    let mut trace = Trace::default();
    let start = Instant::now();

    eprintln!("[react] START: {}", &task[..task.len().min(120)]);

    for i in 0..opts.max_iterations {
        trace.iterations = i + 1;
        eprintln!("[react] iteration {}", i + 1);

        let body = json!({
            "model":      "claude-opus-4-6",
            "max_tokens": 4096,
            "system":     system,
            "tools":      registry.schemas(),
            "messages":   messages,
        });

        let resp = http.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("HTTP send failed")?;

        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("API error {}: {}", status, text));
        }

        let api: ApiResponse = serde_json::from_str(&text)
            .context("Failed to parse API response")?;

        trace.total_tokens += api.usage.input_tokens + api.usage.output_tokens;

        // Rebuild assistant content as Value array for message history
        let assistant_content: Vec<Value> = api.content.iter().map(|b| {
            let mut v = json!({ "type": b.kind });
            if let Some(t) = &b.text  { v["text"]  = json!(t); }
            if let Some(id) = &b.id   { v["id"]    = json!(id); }
            if let Some(n) = &b.name  { v["name"]  = json!(n); }
            if let Some(inp) = &b.input { v["input"] = inp.clone(); }
            v
        }).collect();
        messages.push(json!({ "role": "assistant", "content": assistant_content }));

        if api.stop_reason == "end_turn" {
            for block in &api.content {
                if block.kind == "text" {
                    if let Some(text) = &block.text {
                        let answer = text.trim().to_string();
                        trace.steps.push(Step::Answer { content: answer.clone() });
                        trace.elapsed_ms = start.elapsed().as_millis();
                        return Ok((answer, trace));
                    }
                }
            }
        }

        if api.stop_reason == "tool_use" {
            let mut tool_results: Vec<Value> = Vec::new();

            for block in &api.content {
                if block.kind != "tool_use" { continue; }
                let name  = block.name.as_deref().unwrap_or("");
                let id    = block.id.as_deref().unwrap_or("");
                let input = block.input.clone().unwrap_or(json!({}));

                // Think
                if name == "think" {
                    let reasoning = input["reasoning"].as_str().unwrap_or("").to_string();
                    let step = Step::Thought { content: reasoning.clone() };
                    if let Some(cb) = &opts.on_step { cb(&step); }
                    trace.steps.push(step);
                    eprintln!("[react] 💭 {}", &reasoning[..reasoning.len().min(200)]);
                    tool_results.push(json!({
                        "type": "tool_result", "tool_use_id": id, "content": "OK"
                    }));
                    continue;
                }

                // Finish
                if name == "finish" {
                    let answer = input["answer"].as_str().unwrap_or("").to_string();
                    trace.steps.push(Step::Answer { content: answer.clone() });
                    trace.elapsed_ms = start.elapsed().as_millis();
                    eprintln!("[react] DONE — {} iters, {} tokens, {}ms",
                        trace.iterations, trace.total_tokens, trace.elapsed_ms);
                    return Ok((answer, trace));
                }

                // Regular action
                let step = Step::Action { tool: name.to_string(), input: input.clone() };
                if let Some(cb) = &opts.on_step { cb(&step); }
                trace.steps.push(step);
                eprintln!("[react] ⚡ {}({})", name, input.to_string().chars().take(200).collect::<String>());

                let (result, is_error) = match registry.call(name, input) {
                    Ok(r)  => (r, false),
                    Err(e) => {
                        eprintln!("[react] ❌ {}: {}", name, e);
                        (format!("Tool error: {}", e), true)
                    }
                };

                let obs = Step::Observation { content: result.clone(), error: is_error };
                if let Some(cb) = &opts.on_step { cb(&obs); }
                trace.steps.push(obs);
                eprintln!("[react] 👁 {}", &result[..result.len().min(200)]);

                tool_results.push(json!({
                    "type":        "tool_result",
                    "tool_use_id": id,
                    "content":     result,
                    "is_error":    is_error,
                }));
            }

            messages.push(json!({ "role": "user", "content": tool_results }));
            continue;
        }

        eprintln!("[react] unexpected stop_reason: {}", api.stop_reason);
        break;
    }

    trace.elapsed_ms = start.elapsed().as_millis();
    Err(anyhow!(
        "ReAct loop did not finish within {} iterations (tokens: {})",
        opts.max_iterations, trace.total_tokens
    ))
}

// ── CLI entry point ───────────────────────────────────────────────────────────

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
            Step::Thought { content } =>
                println!("\n💭 THOUGHT: {}", &content[..content.len().min(300)]),
            Step::Action { tool, input } =>
                println!("\n⚡ ACTION: {}({})", tool, input.to_string().chars().take(200).collect::<String>()),
            Step::Observation { content, error } =>
                println!("\n{} OBSERVE: {}", if *error { "❌" } else { "👁" }, &content[..content.len().min(300)]),
            _ => {}
        })),
        ..Default::default()
    }).await?;

    println!("\n{}", "=".repeat(60));
    println!("FINAL ANSWER:\n{}", answer);
    println!("{}", "=".repeat(60));
    println!("Iterations: {} | Tokens: {} | Time: {}ms",
        trace.iterations, trace.total_tokens, trace.elapsed_ms);
    println!("\nFull trace:");
    println!("{}", serde_json::to_string_pretty(&trace.steps)?);

    Ok(())
}
