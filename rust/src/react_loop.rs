// Production ReAct Loop — Rust
// Provider-agnostic: uses ModelRouter (Claude / DeepSeek / OpenAI).
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// export TAVILY_API_KEY=tvly-...
// cargo run --bin react_loop -- "your task here"

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Trace types ────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    Thought     { content: String },
    Action      { tool: String, input: Value },
    Observation { content: String, error: bool },
    Answer      { content: String },
}

#[derive(Debug, Default, Serialize)]
pub struct Trace {
    pub steps:        Vec<Step>,
    pub total_tokens: u32,
    pub iterations:   usize,
    pub elapsed_ms:   u128,
}

// ── Tool registry ──────────────────────────────────────────────────────────────
type ToolFn = Arc<dyn Fn(Value) -> Result<String> + Send + Sync>;

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
        let mut schemas: Vec<Value> = self.tools.values().map(|t| json!({
            "name":         t.name,
            "description":  t.description,
            "input_schema": t.schema,
        })).collect();
        schemas.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        schemas
    }

    pub fn call(&self, name: &str, input: Value) -> Result<String> {
        let def = self.tools.get(name)
            .ok_or_else(|| anyhow!("Tool '{}' not registered", name))?;
        (def.func)(input)
    }

    fn register_defaults(&mut self) {
        self.register("think",
            "Reason step by step before acting.",
            json!({ "type": "object", "properties": { "reasoning": { "type": "string" } }, "required": ["reasoning"] }),
            Arc::new(|_| Ok("OK".to_string())),
        );

        self.register("search",
            "Search the live web for current information via Tavily.",
            json!({ "type": "object", "properties": { "query": { "type": "string" }, "num_results": { "type": "integer" } }, "required": ["query"] }),
            Arc::new(|input| {
                let query      = input["query"].as_str().unwrap_or("").to_string();
                let n          = input["num_results"].as_u64().unwrap_or(5) as usize;
                let api_key    = env::var("TAVILY_API_KEY").context("TAVILY_API_KEY not set")?;
                let body       = json!({ "api_key": api_key, "query": query, "max_results": n, "search_depth": "basic", "include_answer": true });
                let client     = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
                let resp       = client.post("https://api.tavily.com/search").json(&body).send().context("Tavily request failed")?;
                if !resp.status().is_success() {
                    return Err(anyhow!("Tavily API {}", resp.status()));
                }
                let root: Value = resp.json().context("Tavily parse failed")?;
                let mut parts  = Vec::new();
                if let Some(ans) = root["answer"].as_str() { parts.push(format!("Direct answer: {}", ans)); }
                if let Some(results) = root["results"].as_array() {
                    for (i, r) in results.iter().enumerate() {
                        let title   = r["title"].as_str().unwrap_or("");
                        let url     = r["url"].as_str().unwrap_or("");
                        let content = r["content"].as_str().unwrap_or("");
                        let content = &content[..content.len().min(600)];
                        parts.push(format!("[{}] {}\nURL: {}\n{}", i + 1, title, url, content));
                    }
                }
                if parts.is_empty() { return Ok("No results found.".to_string()); }
                Ok(parts.join("\n\n"))
            }),
        );

        self.register("fetch_url",
            "Fetch and extract readable text from a URL.",
            json!({ "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] }),
            Arc::new(|input| {
                let url    = input["url"].as_str().unwrap_or("").to_string();
                let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?;
                let body   = client.get(&url).send().context("HTTP GET failed")?.text().context("Read body")?;
                let mut result = String::new();
                let mut in_tag = false;
                for c in body.chars() {
                    match c {
                        '<'             => in_tag = true,
                        '>'             => in_tag = false,
                        _ if !in_tag   => result.push(c),
                        _              => {}
                    }
                }
                let clean: String = result.split_whitespace().collect::<Vec<_>>().join(" ");
                Ok(clean.chars().take(8000).collect())
            }),
        );

        self.register("run_bash",
            "Execute a bash command. Returns stdout+stderr. Timeout 15s.",
            json!({ "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }),
            Arc::new(|input| {
                let command = input["command"].as_str().unwrap_or("").to_string();
                let output  = Command::new("bash").args(["-c", &command]).output().context("Failed to run bash")?;
                let combined = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)).trim().to_string();
                if combined.is_empty() { return Ok("(no output)".to_string()); }
                Ok(combined.chars().take(8000).collect())
            }),
        );

        self.register("read_file",
            "Read a file from disk.",
            json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
            Arc::new(|input| {
                let path = input["path"].as_str().unwrap_or("").to_string();
                fs::read_to_string(&path).context("Read file failed")
            }),
        );

        self.register("write_file",
            "Write content to a file on disk.",
            json!({ "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }),
            Arc::new(|input| {
                let path    = input["path"].as_str().unwrap_or("").to_string();
                let content = input["content"].as_str().unwrap_or("").to_string();
                let len     = content.len();
                fs::write(&path, &content).context("Write file failed")?;
                Ok(format!("Written {} bytes to {}", len, path))
            }),
        );

        self.register("finish",
            "Call when you have the final answer. Ends the loop.",
            json!({ "type": "object", "properties": { "answer": { "type": "string" } }, "required": ["answer"] }),
            Arc::new(|input| Ok(input["answer"].as_str().unwrap_or("").to_string())),
        );
    }
}

// ── ReAct system prompt ────────────────────────────────────────────────────────
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
- Do not guess. If unsure, use search or fetch_url.\n\
- Be thorough. Do not call finish until the task is fully complete.";

// ── Core ReAct engine ──────────────────────────────────────────────────────────
pub struct ReactOptions {
    pub system_extra:   String,
    pub max_iterations: usize,
    pub on_step:        Option<Box<dyn Fn(&Step) + Send>>,
}

impl Default for ReactOptions {
    fn default() -> Self {
        Self { system_extra: String::new(), max_iterations: 30, on_step: None }
    }
}

pub async fn run_react(
    task:     &str,
    registry: &ToolRegistry,
    opts:     ReactOptions,
) -> Result<(String, Trace)> {
    let router = ModelRouter::new(None, None)?;

    let system = if opts.system_extra.is_empty() {
        REACT_SYSTEM.to_string()
    } else {
        format!("{}\n\n{}", REACT_SYSTEM, opts.system_extra)
    };

    let tool_schemas: Vec<Value> = registry.schemas();
    let mut messages: Vec<Value> = vec![json!({ "role": "user", "content": task })];
    let mut trace  = Trace::default();
    let start      = Instant::now();

    eprintln!("[react] START provider={} model={} task={}", router.provider, router.model, &task[..task.len().min(120)]);

    for i in 0..opts.max_iterations {
        trace.iterations = i + 1;
        eprintln!("[react] iteration {}", i + 1);

        let resp = router.create(
            &messages,
            Some(&tool_schemas),
            Some(&system),
            4096,
        ).await?;

        trace.total_tokens += resp.input_tokens + resp.output_tokens;
        messages.push(resp.to_assistant_message());

        if resp.stop_reason == "end_turn" {
            for block in &resp.content {
                if let crate::ContentBlock::Text { text } = block {
                    let answer = text.trim().to_string();
                    if !answer.is_empty() {
                        trace.steps.push(Step::Answer { content: answer.clone() });
                        trace.elapsed_ms = start.elapsed().as_millis();
                        return Ok((answer, trace));
                    }
                }
            }
        }

        if resp.stop_reason == "tool_use" {
            let mut tool_results: Vec<Value> = Vec::new();

            for block in &resp.content {
                if let crate::ContentBlock::ToolUse { id, name, input } = block {
                    if name == "think" {
                        let reasoning = input.get("reasoning")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let step = Step::Thought { content: reasoning.clone() };
                        if let Some(cb) = &opts.on_step { cb(&step); }
                        trace.steps.push(step);
                        eprintln!("[react] 💭 {}", &reasoning[..reasoning.len().min(200)]);
                        tool_results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": "OK" }));
                        continue;
                    }

                    if name == "finish" {
                        let answer = input.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        trace.steps.push(Step::Answer { content: answer.clone() });
                        trace.elapsed_ms = start.elapsed().as_millis();
                        eprintln!("[react] DONE — {} iters, {} tokens, {}ms", trace.iterations, trace.total_tokens, trace.elapsed_ms);
                        return Ok((answer, trace));
                    }

                    let input_val = json!(input);
                    let step = Step::Action { tool: name.clone(), input: input_val.clone() };
                    if let Some(cb) = &opts.on_step { cb(&step); }
                    trace.steps.push(step);
                    eprintln!("[react] ⚡ {}({})", name, input_val.to_string().chars().take(200).collect::<String>());

                    let (result, is_error) = match registry.call(name, input_val) {
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
                    tool_results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": result, "is_error": is_error }));
                }
            }

            messages.push(json!({ "role": "user", "content": tool_results }));
            continue;
        }

        eprintln!("[react] unexpected stop_reason: {}", resp.stop_reason);
        break;
    }

    trace.elapsed_ms = start.elapsed().as_millis();
    Err(anyhow!("ReAct loop did not finish within {} iterations (tokens: {})", opts.max_iterations, trace.total_tokens))
}
