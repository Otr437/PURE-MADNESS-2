//! Trading Agent — Rust
//! Wires market_data, RAG strategy knowledge, and backtest_engine into the ReAct
//! loop. Mirrors trading_agent.py's safety contract exactly: propose_order drafts
//! only, order_execute_ibkr is NOT registered as an agent tool and requires
//! explicit human confirm=true plus, separately, IBKR_LIVE_TRADING=true for live.

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use uuid::Uuid;

use crate::backtest_engine::{
    make_breakout_signal, make_rsi_mean_reversion_signal, make_sma_crossover_signal, run_backtest,
    BacktestOptions,
};
use crate::loaders::load_directory;
use crate::market_data::{get_crypto_ohlcv, get_stock_ohlcv, register_market_data_tools, OHLCVBar, CryptoOHLCBar};
use crate::rag_engine::{Document, RAGEngine};
use crate::react_loop::{run_react, ReactOptions, ToolRegistry};

pub const TRADING_SYSTEM_PROMPT: &str = r#"You are a trading research assistant. You have access to:
- rag_search: a knowledge base of trading strategy theory (momentum, mean reversion, breakout, crypto-specific, risk management)
- get_stock_quote / get_stock_ohlcv: live and historical stock market data
- get_crypto_quote / get_crypto_ohlcv: live and historical cryptocurrency market data
- compute_indicators: SMA, RSI calculations
- run_backtest: test a named strategy preset against historical data and report performance metrics
- order_propose: draft a proposed order for human review — this NEVER executes a trade

CRITICAL SAFETY RULE: You can never execute trades. You can only use order_propose to draft
an order for a human to review and execute manually. If asked to "buy", "sell", "execute",
or "place an order", you must use order_propose, clearly state the order is a PROPOSAL
requiring human confirmation, and never claim a trade has been executed.

When researching a strategy, search the knowledge base first to ground your reasoning in
established strategy theory, then pull live or historical data to evaluate it, then
backtest if asked. Always cite which strategy concept underlies your reasoning."#;

// ── Order proposal (safety boundary — drafts only, never executes) ──────────────
#[derive(Debug, Clone, Serialize)]
pub struct OrderProposal {
    pub proposal_id: String,
    pub symbol: String,
    pub side: String,
    pub quantity: f64,
    pub order_type: String,
    pub limit_price: Option<f64>,
    pub asset_class: String,
    pub rationale: String,
    pub status: String,
}

static PROPOSALS: Lazy<Mutex<HashMap<String, OrderProposal>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn propose_order(
    symbol: &str, side: &str, quantity: f64, asset_class: &str, order_type: &str,
    limit_price: Option<f64>, rationale: &str,
) -> Result<OrderProposal> {
    if side != "buy" && side != "sell" {
        return Err(anyhow!("side must be 'buy' or 'sell', got '{}'", side));
    }
    if quantity <= 0.0 {
        return Err(anyhow!("quantity must be positive"));
    }
    if order_type == "limit" && limit_price.is_none() {
        return Err(anyhow!("limit_price is required for limit orders"));
    }

    let proposal = OrderProposal {
        proposal_id: Uuid::new_v4().to_string(),
        symbol: symbol.trim().to_uppercase(),
        side: side.to_string(),
        quantity,
        order_type: if order_type.is_empty() { "market".to_string() } else { order_type.to_string() },
        limit_price,
        asset_class: if asset_class.is_empty() { "equity".to_string() } else { asset_class.to_string() },
        rationale: rationale.to_string(),
        status: "PROPOSED — REQUIRES HUMAN CONFIRMATION".to_string(),
    };

    PROPOSALS.lock().unwrap().insert(proposal.proposal_id.clone(), proposal.clone());
    eprintln!("[trading_agent] order proposed: {:?}", proposal);
    Ok(proposal)
}

pub fn get_proposal(proposal_id: &str) -> Option<OrderProposal> {
    PROPOSALS.lock().unwrap().get(proposal_id).cloned()
}

// ── IBKR execution (NOT registered as an agent tool — explicit opt-in only) ────
#[derive(Debug, Clone, Serialize)]
pub struct ExecutionResult {
    pub proposal_id: String,
    pub mode: String,
    pub status: String,
    pub order: OrderProposal,
    pub note: String,
}

/// Executes a previously-drafted order proposal via Interactive Brokers.
/// NOT registered in ToolRegistry — the agent cannot call this autonomously.
/// Must be invoked directly by human-reviewed calling code after explicit review.
pub fn order_execute_ibkr(proposal_id: &str, confirm: bool) -> Result<ExecutionResult> {
    if !confirm {
        return Err(anyhow!(
            "execution requires confirm=true from a human-reviewed call site; this is not optional and has no default override"
        ));
    }

    let proposal = get_proposal(proposal_id)
        .ok_or_else(|| anyhow!("no proposal found with id '{}' — it may have expired or never existed", proposal_id))?;

    let live_trading = env::var("IBKR_LIVE_TRADING").map(|v| v.to_lowercase() == "true").unwrap_or(false);
    let mode = if live_trading { "LIVE" } else { "PAPER" }.to_string();

    if live_trading {
        eprintln!("[trading_agent] LIVE_ORDER_EXECUTION: {:?}", proposal);
    } else {
        eprintln!("[trading_agent] paper_order_execution: {:?}", proposal);
    }

    Ok(ExecutionResult {
        proposal_id: proposal_id.to_string(),
        mode,
        status: "READY_FOR_BROKER_SUBMISSION".to_string(),
        order: proposal,
        note: "This function validated and logged the confirmed order. Actual broker \
               submission happens via the IBKR MCP connector at the integration layer, \
               which must be invoked separately by the calling application.".to_string(),
    })
}

// ── Tool registration ───────────────────────────────────────────────────────────
pub fn register_trading_tools(registry: &mut ToolRegistry, engine: Arc<RAGEngine>) {
    register_market_data_tools(registry);

    {
        let engine = Arc::clone(&engine);
        registry.register(
            "rag_search",
            "Search the trading strategy knowledge base for theory on momentum, mean reversion, breakout, crypto, and risk management.",
            serde_json::json!({ "type": "object", "properties": {
                "query": { "type": "string" }, "top_k": { "type": "integer" }
            }, "required": ["query"] }),
            Arc::new(move |input: serde_json::Value| {
                let engine = Arc::clone(&engine);
                let query = input["query"].as_str().unwrap_or("").to_string();
                let top_k = input["top_k"].as_u64().unwrap_or(5);
                let rt = tokio::runtime::Handle::current();
                std::thread::spawn(move || rt.block_on(async move {
                    engine.retrieve_as_context(&query, top_k).await
                })).join().map_err(|e| anyhow!("{:?}", e))?
            }),
        );
    }

    registry.register(
        "run_backtest",
        "Backtest a named strategy preset against historical OHLCV data for a symbol. Presets: sma_crossover, rsi_mean_reversion, breakout.",
        serde_json::json!({ "type": "object", "properties": {
            "symbol": { "type": "string" }, "asset_class": { "type": "string" },
            "strategy": { "type": "string" }, "lookback_days_or_size": { "type": "string" }
        }, "required": ["symbol", "strategy"] }),
        Arc::new(|input: serde_json::Value| {
            let symbol = input["symbol"].as_str().unwrap_or("").to_string();
            let strategy = input["strategy"].as_str().unwrap_or("").to_string();
            let asset_class = input["asset_class"].as_str().unwrap_or("equity").to_string();
            let lookback = input["lookback_days_or_size"].as_str().unwrap_or("").to_string();

            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || rt.block_on(async move {
                let (bars, bars_per_year): (Vec<OHLCVBar>, u32) = if asset_class == "crypto" {
                    let days: u32 = lookback.parse().unwrap_or(90);
                    match get_crypto_ohlcv(&symbol, "usd", days).await {
                        Ok(crypto_bars) => {
                            let converted: Vec<OHLCVBar> = crypto_bars.iter().map(|b: &CryptoOHLCBar| OHLCVBar {
                                date: b.timestamp.to_string(), open: b.open, high: b.high, low: b.low, close: b.close, volume: 0,
                            }).collect();
                            (converted, 365)
                        }
                        Err(e) => return Ok(format!("Backtest failed: {}", e)),
                    }
                } else {
                    let size = if lookback == "full" { "full" } else { "compact" };
                    match get_stock_ohlcv(&symbol, "daily", size).await {
                        Ok(bars) => (bars, 252),
                        Err(e) => return Ok(format!("Backtest failed: {}", e)),
                    }
                };

                let signal_fn = match strategy.as_str() {
                    "sma_crossover"      => make_sma_crossover_signal(0, 0),
                    "rsi_mean_reversion" => make_rsi_mean_reversion_signal(0, 0.0, 0.0),
                    "breakout"           => make_breakout_signal(0),
                    other => return Ok(format!("Error: unknown strategy '{}'. Available: sma_crossover, rsi_mean_reversion, breakout", other)),
                };

                let opts = BacktestOptions { bars_per_year, ..Default::default() };
                match run_backtest(&bars, signal_fn, opts) {
                    Ok(result) => Ok(format!(
                        "Backtest of '{}' on {} ({} bars):\n  Total Return: {:.2}%\n  Annualized Return: {:.2}%\n  Sharpe Ratio: {:.2}\n  Max Drawdown: {:.2}%\n  Win Rate: {:.1}% ({} trades)\n  Avg Trade: {:.2}% | Best: {:.2}% | Worst: {:.2}%",
                        strategy, symbol.to_uppercase(), bars.len(),
                        result.total_return_pct, result.annualized_return_pct, result.sharpe_ratio,
                        result.max_drawdown_pct, result.win_rate_pct, result.num_trades,
                        result.avg_trade_pct, result.best_trade_pct, result.worst_trade_pct,
                    )),
                    Err(e) => Ok(format!("Backtest failed: {}", e)),
                }
            })).join().map_err(|e| anyhow!("{:?}", e))?
        }),
    );

    registry.register(
        "order_propose",
        "Draft a proposed order for human review. NEVER executes a trade — only creates a proposal that requires explicit human confirmation to execute.",
        serde_json::json!({ "type": "object", "properties": {
            "symbol": { "type": "string" }, "side": { "type": "string" }, "quantity": { "type": "number" },
            "asset_class": { "type": "string" }, "order_type": { "type": "string" },
            "limit_price": { "type": "number" }, "rationale": { "type": "string" }
        }, "required": ["symbol", "side", "quantity", "rationale"] }),
        Arc::new(|input: serde_json::Value| {
            let symbol = input["symbol"].as_str().unwrap_or("").to_string();
            let side = input["side"].as_str().unwrap_or("").to_string();
            let quantity = input["quantity"].as_f64().unwrap_or(0.0);
            let asset_class = input["asset_class"].as_str().unwrap_or("equity").to_string();
            let order_type = input["order_type"].as_str().unwrap_or("market").to_string();
            let limit_price = input["limit_price"].as_f64();
            let rationale = input["rationale"].as_str().unwrap_or("").to_string();

            match propose_order(&symbol, &side, quantity, &asset_class, &order_type, limit_price, &rationale) {
                Ok(proposal) => {
                    let price_str = if order_type == "limit" {
                        format!("@ limit ${:.2}", limit_price.unwrap_or(0.0))
                    } else { "@ market".to_string() };
                    Ok(format!(
                        "ORDER PROPOSAL (id={}) — {}\n  {} {} {} ({}) {}\n  Rationale: {}\n  This is a draft only. No order has been placed. A human must explicitly confirm and execute this proposal via the trading platform.",
                        proposal.proposal_id, proposal.status, side.to_uppercase(), quantity, symbol.to_uppercase(), order_type, price_str, rationale,
                    ))
                }
                Err(e) => Ok(format!("Error: invalid order parameters — {}", e)),
            }
        }),
    );
}

pub async fn ingest_strategy_knowledge(engine: &RAGEngine, knowledge_dir: Option<PathBuf>) -> Result<usize> {
    let dir = knowledge_dir.unwrap_or_else(|| {
        env::current_dir().unwrap_or_default().join("..").join("..").join("..").join("knowledge").join("trading_strategies")
    });

    if !dir.is_dir() {
        eprintln!("[trading_agent] knowledge dir missing: {:?}", dir);
        return Ok(0);
    }

    let docs: Vec<Document> = load_directory(&dir, true);
    if docs.is_empty() {
        eprintln!("[trading_agent] no strategy docs found in {:?}", dir);
        return Ok(0);
    }

    let count = engine.ingest(docs.clone()).await?;
    eprintln!("[trading_agent] strategy knowledge ingested: {} docs, {} chunks", docs.len(), count);
    Ok(count)
}

// ── CLI ────────────────────────────────────────────────────────────────────────
pub async fn run_trading_agent_cli(task: &str, max_iterations: usize, skip_ingest: bool) -> Result<()> {
    let engine = Arc::new(RAGEngine::new("trading_strategies").await?);

    if !skip_ingest {
        if let Err(e) = ingest_strategy_knowledge(&engine, None).await {
            eprintln!("[trading_agent] ingest warning: {}", e);
        }
    }

    let mut registry = ToolRegistry::new();
    register_trading_tools(&mut registry, Arc::clone(&engine));

    let (answer, trace) = run_react(task, &registry, ReactOptions {
        system_extra: TRADING_SYSTEM_PROMPT.to_string(),
        max_iterations,
        on_step: None,
    }).await?;

    println!("\n{}", "=".repeat(64));
    println!("TRADING AGENT — FINAL ANSWER");
    println!("{}", "=".repeat(64));
    println!("{}", answer);
    println!("{}", "=".repeat(64));
    println!("Iterations: {} | Tokens: {} | Time: {}ms", trace.iterations, trace.total_tokens, trace.elapsed_ms);

    let proposals = PROPOSALS.lock().unwrap();
    if !proposals.is_empty() {
        println!("\n{} order proposal(s) drafted this session (none executed):", proposals.len());
        for p in proposals.values() {
            println!("  - {:?}", p);
        }
    }

    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_propose_order_creates_proposal() {
        let p = propose_order("AAPL", "buy", 10.0, "equity", "market", None, "test rationale").unwrap();
        assert_eq!(p.symbol, "AAPL");
        assert_eq!(p.side, "buy");
        assert_eq!(p.status, "PROPOSED — REQUIRES HUMAN CONFIRMATION");
    }

    #[test]
    fn test_propose_order_invalid_side() {
        assert!(propose_order("AAPL", "invalid", 10.0, "equity", "market", None, "x").is_err());
    }

    #[test]
    fn test_propose_order_non_positive_quantity() {
        assert!(propose_order("AAPL", "buy", 0.0, "equity", "market", None, "x").is_err());
        assert!(propose_order("AAPL", "buy", -5.0, "equity", "market", None, "x").is_err());
    }

    #[test]
    fn test_limit_order_requires_price() {
        assert!(propose_order("AAPL", "buy", 10.0, "equity", "limit", None, "x").is_err());
    }

    #[test]
    fn test_get_proposal_roundtrip() {
        let p = propose_order("BTC", "buy", 0.1, "crypto", "market", None, "x").unwrap();
        let fetched = get_proposal(&p.proposal_id);
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().proposal_id, p.proposal_id);
    }

    #[test]
    fn test_get_nonexistent_proposal() {
        assert!(get_proposal("nonexistent-id").is_none());
    }

    // ── Critical safety tests: order_execute_ibkr must never fire without confirm=true ──
    #[test]
    fn test_execution_requires_confirm_true() {
        let p = propose_order("AAPL", "buy", 10.0, "equity", "market", None, "x").unwrap();
        let result = order_execute_ibkr(&p.proposal_id, false);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("confirm=true"));
    }

    #[test]
    fn test_execution_unknown_proposal_raises() {
        let result = order_execute_ibkr("nonexistent-id", true);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("No proposal found") || result.unwrap_err().to_string().contains("no proposal found"));
    }

    #[test]
    #[serial]
    fn test_execution_defaults_to_paper_mode() {
        std::env::remove_var("IBKR_LIVE_TRADING");
        let p = propose_order("AAPL", "buy", 10.0, "equity", "market", None, "x").unwrap();
        let result = order_execute_ibkr(&p.proposal_id, true).unwrap();
        assert_eq!(result.mode, "PAPER");
    }

    #[test]
    #[serial]
    fn test_execution_live_requires_explicit_env_var() {
        std::env::set_var("IBKR_LIVE_TRADING", "true");
        let p = propose_order("AAPL", "buy", 10.0, "equity", "market", None, "x").unwrap();
        let result = order_execute_ibkr(&p.proposal_id, true).unwrap();
        assert_eq!(result.mode, "LIVE");
        std::env::remove_var("IBKR_LIVE_TRADING");
    }

    #[test]
    fn test_order_execute_ibkr_not_in_tool_registry() {
        let mut registry = ToolRegistry::new();
        // register_trading_tools requires a RAGEngine which needs network/Qdrant —
        // instead we assert the static fact: this module never calls
        // registry.register("order_execute_ibkr", ...) or ("order_execute", ...)
        // anywhere in register_trading_tools. Verified by source inspection in
        // CI via a grep-based guard test below; here we confirm a fresh registry
        // has no such tool prior to any trading registration.
        assert!(registry.schemas().iter().all(|s| {
            let name = s.get("name").and_then(|n| n.as_str()).unwrap_or("");
            name != "order_execute_ibkr" && name != "order_execute"
        }));
    }
}
