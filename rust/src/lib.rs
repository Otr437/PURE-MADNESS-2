//! RAG AI Monorepo — Rust library crate root.
//!
//! All shared modules (rag_engine, loaders, memory, model_router, react_loop,
//! token_engine) live here as library code. Binaries in src/bin/ are thin
//! wrappers that `use rag_ai_rust::*` to access this shared implementation,
//! so there is exactly one compiled copy of each type/function instead of
//! per-binary duplication.

pub mod rag_engine;
pub mod loaders;
pub mod memory;
pub mod model_router;
pub mod react_loop;
pub mod token_engine;
pub mod eval_harness;
pub mod agent_loop;
pub mod harness_react;
pub mod rag_agent;
pub mod run_agent;
pub mod rag_api;
pub mod market_data;
pub mod backtest_engine;
pub mod trading_agent;

// Re-export the most commonly used items at the crate root so existing
// `use crate::{RAGEngine, Document, ...}` statements throughout the
// non-lib.rs source files continue to resolve without modification.
pub use rag_engine::{RAGEngine, Document, Chunk, RetrievedChunk, chunk_text};
pub use loaders::{load_txt, load_markdown, load_html, load_pdf, load_docx, load_document, load_directory};
pub use memory::{Session as MemorySession, MemoryStore, build_context_messages};
pub use model_router::{ModelRouter, ContentBlock, UnifiedResponse, make_tool_result_message};
pub use react_loop::{run_react, ReactOptions, ToolRegistry, Step, Trace};
pub use token_engine::{
    TokenEngine, TokenEngineOptions, RBACConfig, Role, Session as TokenSession,
    BudgetExceededError, default_config,
};
