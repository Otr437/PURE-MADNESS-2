// Model Router — Rust
// Unified multi-provider chat-completion client.
// Providers: Anthropic Claude, DeepSeek (Anthropic-compat), OpenAI.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY

use std::collections::HashMap;
use std::env;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Types ──────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text    { text: String },
    ToolUse { id: String, name: String, input: HashMap<String, Value> },
}

#[derive(Debug, Clone)]
pub struct UnifiedResponse {
    pub content:     Vec<ContentBlock>,
    pub stop_reason: String,
    pub input_tokens:  u32,
    pub output_tokens: u32,
}

impl UnifiedResponse {
    pub fn to_assistant_message(&self) -> Value {
        let blocks: Vec<Value> = self.content.iter().map(|b| match b {
            ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
            ContentBlock::ToolUse { id, name, input } => json!({
                "type": "tool_use", "id": id, "name": name, "input": input
            }),
        }).collect();
        json!({ "role": "assistant", "content": blocks })
    }
}

// ── Default models ─────────────────────────────────────────────────────────────
fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-opus-4-6",
        "deepseek"  => "deepseek-v4-pro",
        "openai"    => "gpt-5.5",
        _           => "claude-opus-4-6",
    }
}

// ── ModelRouter ────────────────────────────────────────────────────────────────
pub struct ModelRouter {
    pub provider: String,
    pub model:    String,
    base_url:     String,
    api_key:      String,
    http:         Client,
}

impl ModelRouter {
    pub fn new(provider: Option<&str>, model: Option<&str>) -> Result<Self> {
        let provider = provider
            .map(str::to_string)
            .or_else(|| env::var("MODEL_PROVIDER").ok())
            .unwrap_or_else(|| "anthropic".to_string());

        let model = model
            .map(str::to_string)
            .or_else(|| env::var("MODEL_NAME").ok())
            .unwrap_or_else(|| default_model(&provider).to_string());

        let (base_url, api_key) = match provider.as_str() {
            "anthropic" => (
                "https://api.anthropic.com".to_string(),
                env::var("ANTHROPIC_API_KEY").context("ANTHROPIC_API_KEY not set")?,
            ),
            "deepseek" => (
                "https://api.deepseek.com/anthropic".to_string(),
                env::var("DEEPSEEK_API_KEY").context("DEEPSEEK_API_KEY not set")?,
            ),
            "openai" => (
                "https://api.openai.com".to_string(),
                env::var("OPENAI_API_KEY").context("OPENAI_API_KEY not set")?,
            ),
            other => anyhow::bail!("Unknown MODEL_PROVIDER '{}'", other),
        };

        Ok(Self {
            provider,
            model,
            base_url,
            api_key,
            http: Client::builder().timeout(std::time::Duration::from_secs(90)).build()?,
        })
    }

    pub async fn create(
        &self,
        messages: &[Value],
        tools:     Option<&[Value]>,
        system:    Option<&str>,
        max_tokens: u32,
    ) -> Result<UnifiedResponse> {
        match self.provider.as_str() {
            "anthropic" | "deepseek" => self.create_anthropic(messages, tools, system, max_tokens).await,
            "openai"                  => self.create_openai(messages, tools, system, max_tokens).await,
            other => anyhow::bail!("Unsupported provider '{}'", other),
        }
    }

    // ── Anthropic-format ──────────────────────────────────────────────────────
    async fn create_anthropic(
        &self,
        messages:   &[Value],
        tools:      Option<&[Value]>,
        system:     Option<&str>,
        max_tokens: u32,
    ) -> Result<UnifiedResponse> {
        let mut body = json!({
            "model":      self.model,
            "max_tokens": max_tokens,
            "messages":   messages,
        });
        if let Some(sys) = system {
            body["system"] = json!(sys);
        }
        if let Some(t) = tools {
            if !t.is_empty() { body["tools"] = json!(t); }
        }

        let resp = self.http
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text   = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Anthropic API {} : {}", status, text);
        }
        let root: Value = serde_json::from_str(&text)?;
        self.parse_anthropic_response(&root)
    }

    fn parse_anthropic_response(&self, root: &Value) -> Result<UnifiedResponse> {
        let stop_reason = root["stop_reason"].as_str().unwrap_or("end_turn").to_string();
        let input_tokens  = root["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32;
        let output_tokens = root["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32;
        let mut content = Vec::new();
        for b in root["content"].as_array().unwrap_or(&vec![]) {
            match b["type"].as_str() {
                Some("text") => content.push(ContentBlock::Text { text: b["text"].as_str().unwrap_or("").to_string() }),
                Some("tool_use") => {
                    let input: HashMap<String, Value> = serde_json::from_value(b["input"].clone()).unwrap_or_default();
                    content.push(ContentBlock::ToolUse {
                        id:    b["id"].as_str().unwrap_or("").to_string(),
                        name:  b["name"].as_str().unwrap_or("").to_string(),
                        input,
                    });
                }
                _ => {}
            }
        }
        Ok(UnifiedResponse { content, stop_reason, input_tokens, output_tokens })
    }

    // ── OpenAI-format ─────────────────────────────────────────────────────────
    async fn create_openai(
        &self,
        messages:   &[Value],
        tools:      Option<&[Value]>,
        system:     Option<&str>,
        max_tokens: u32,
    ) -> Result<UnifiedResponse> {
        let mut oa_messages: Vec<Value> = Vec::new();
        if let Some(sys) = system {
            oa_messages.push(json!({ "role": "system", "content": sys }));
        }
        oa_messages.extend_from_slice(messages);

        let mut body = json!({
            "model":      self.model,
            "max_tokens": max_tokens,
            "messages":   oa_messages,
        });
        if let Some(t) = tools {
            if !t.is_empty() {
                let oa_tools: Vec<Value> = t.iter().map(|tool| json!({
                    "type": "function",
                    "function": {
                        "name":        tool["name"],
                        "description": tool["description"],
                        "parameters":  tool["input_schema"],
                    }
                })).collect();
                body["tools"]       = json!(oa_tools);
                body["tool_choice"] = json!("auto");
            }
        }

        let resp = self.http
            .post(format!("{}/v1/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text   = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("OpenAI API {} : {}", status, text);
        }
        let root: Value = serde_json::from_str(&text)?;
        let choice = &root["choices"][0];
        let msg    = &choice["message"];

        let mut content      = Vec::new();
        let mut stop_reason  = "end_turn".to_string();
        let input_tokens     = root["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32;
        let output_tokens    = root["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32;

        if let Some(text) = msg["content"].as_str() {
            if !text.is_empty() { content.push(ContentBlock::Text { text: text.to_string() }); }
        }
        if let Some(tool_calls) = msg["tool_calls"].as_array() {
            stop_reason = "tool_use".to_string();
            for tc in tool_calls {
                let args = tc["function"]["arguments"].as_str().unwrap_or("{}");
                let input: HashMap<String, Value> = serde_json::from_str(args).unwrap_or_default();
                content.push(ContentBlock::ToolUse {
                    id:   tc["id"].as_str().unwrap_or("").to_string(),
                    name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                    input,
                });
            }
        }
        Ok(UnifiedResponse { content, stop_reason, input_tokens, output_tokens })
    }
}

// ── Tool result helper ────────────────────────────────────────────────────────
pub fn make_tool_result_message(tool_use_id: &str, content: &str, is_error: bool) -> Value {
    let mut block = json!({
        "type":        "tool_result",
        "tool_use_id": tool_use_id,
        "content":     content,
    });
    if is_error { block["is_error"] = json!(true); }
    json!({ "role": "user", "content": [block] })
}
