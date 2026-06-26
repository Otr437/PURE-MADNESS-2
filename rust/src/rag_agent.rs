// RAG Agent — Rust
// Wires RAGEngine (hybrid search, reranking, citations) + document loaders
// into the multi-provider ReAct loop.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// export VOYAGE_API_KEY=... QDRANT_URL=http://localhost:6333
//
// cargo run --bin run_agent -- agent --task "your question"
// cargo run --bin run_agent -- agent --dir ./docs --task "your question"

use std::env;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use serde_json::json;

use crate::{Document, RAGEngine, ToolRegistry, ReactOptions, run_react, load_directory, load_document};

const RAG_SYSTEM_PROMPT: &str = "You have access to a 'rag_search' tool that searches a knowledge base \
of ingested documents using hybrid retrieval with reranking. Results include citation markers. \
Use rag_search to find relevant context before answering factual questions. \
Always search first, reason second, then answer. Cite retrieved passages.";

fn default_docs() -> Vec<Document> {
    vec![
        Document {
            content: "Claude is an AI assistant made by Anthropic, designed to be helpful, harmless, and honest.".to_string(),
            metadata: [("source".to_string(), "anthropic_docs".to_string())].into(),
            doc_id: None,
        },
        Document {
            content: "RAG (Retrieval-Augmented Generation) combines retrieval with generation to ground LLM answers in real documents.".to_string(),
            metadata: [("source".to_string(), "rag_survey".to_string())].into(),
            doc_id: None,
        },
        Document {
            content: "Qdrant is a high-performance vector database written in Rust, supporting cosine, dot product, and Euclidean distance.".to_string(),
            metadata: [("source".to_string(), "qdrant_docs".to_string())].into(),
            doc_id: None,
        },
    ]
}

pub async fn run_rag_agent(
    docs: Vec<Document>,
    task: &str,
    system_extra: &str,
    max_iterations: usize,
    verbose: bool,
) -> Result<(String, crate::Trace)> {
    // Init RAG engine
    let engine = Arc::new(RAGEngine::new("default").await?);

    if !docs.is_empty() {
        let count = engine.ingest(docs).await?;
        eprintln!("[rag-agent] Ingested {} chunks", count);
    }

    // Build tool registry with rag_search wired in
    let mut registry = ToolRegistry::new();
    let engine_clone = Arc::clone(&engine);
    registry.register(
        "rag_search",
        "Search the knowledge base for context relevant to a query.",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "top_k": { "type": "integer" }
            },
            "required": ["query"]
        }),
        std::sync::Arc::new(move |input: serde_json::Value| {
            let engine = Arc::clone(&engine_clone);
            // Blocking call inside sync closure — safe for CLI usage
            let query  = input["query"].as_str().unwrap_or("").to_string();
            let top_k  = input["top_k"].as_u64().unwrap_or(5) as u64;
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || {
                rt.block_on(async move {
                    engine.retrieve_as_context(&query, top_k).await
                })
            }).join().map_err(|e| anyhow::anyhow!("thread panic: {:?}", e))?
        }),
    );

    let combined = if system_extra.is_empty() {
        RAG_SYSTEM_PROMPT.to_string()
    } else {
        format!("{}\n\n{}", RAG_SYSTEM_PROMPT, system_extra)
    };

    let on_step: Option<Box<dyn Fn(&crate::Step) + Send>> = if verbose {
        Some(Box::new(|step| match step {
            crate::Step::Thought { content }        => println!("\n💭 THOUGHT: {}", &content[..content.len().min(300)]),
            crate::Step::Action { tool, input }     => println!("\n⚡ ACTION: {}({})", tool, input.to_string().chars().take(200).collect::<String>()),
            crate::Step::Observation { content, error } => println!("\n{} OBSERVE: {}", if *error { "❌" } else { "👁" }, &content[..content.len().min(300)]),
            _ => {}
        }))
    } else {
        None
    };

    run_react(task, &registry, ReactOptions {
        system_extra:   combined,
        max_iterations,
        on_step,
    }).await
}

pub async fn run_agent_cli() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect(); // skip binary name only
    let mut task = String::new();
    let mut dir  = String::new();
    let mut max_iter = 30usize;
    let mut verbose = true;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--task" | "-task" => { if i + 1 < args.len() { task = args[i+1].clone(); i += 1; } }
            "--dir"  | "-dir"  => { if i + 1 < args.len() { dir  = args[i+1].clone(); i += 1; } }
            "--max-iterations"  => { if i + 1 < args.len() { max_iter = args[i+1].parse().unwrap_or(30); i += 1; } }
            "--quiet"           => { verbose = false; }
            _                   => {}
        }
        i += 1;
    }

    if task.is_empty() {
        task = "Explain how the ReAct pattern works and how it relates to RAG.".to_string();
    }

    let docs = if dir.is_empty() {
        default_docs()
    } else {
        load_directory(Path::new(&dir), true)
    };

    let (answer, trace) = run_rag_agent(docs, &task, "", max_iter, verbose).await?;

    println!("\n{}", "=".repeat(64));
    println!("FINAL ANSWER\n{}", "=".repeat(64));
    println!("{}", answer);
    println!("{}", "=".repeat(64));
    println!("Iterations: {} | Tokens: {} | Time: {}ms", trace.iterations, trace.total_tokens, trace.elapsed_ms);
    Ok(())
}
