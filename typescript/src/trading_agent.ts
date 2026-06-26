/**
 * Trading Agent — TypeScript
 * Wires market_data, RAG strategy knowledge, and backtest_engine into the ReAct loop.
 * Mirrors trading_agent.py's safety contract exactly: order_propose drafts only,
 * order_execute_ibkr is NOT registered as an agent tool and requires explicit
 * human confirm=true plus, separately, IBKR_LIVE_TRADING=true for live trading.
 *
 * export MODEL_PROVIDER=anthropic|deepseek|openai
 * export ALPHA_VANTAGE_API_KEY=...
 * export VOYAGE_API_KEY=...
 * export QDRANT_URL=http://localhost:6333
 *
 * npx ts-node src/trading_agent.ts --task "Backtest SMA crossover on AAPL"
 */

import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";

import { registerTool, runReact, toolRegistry } from "./react_loop";
import { RAGEngine } from "./rag_engine";
import { loadDirectory } from "./loaders";
import {
  getStockOHLCV, getCryptoOHLCV, registerMarketDataTools, MarketDataError,
} from "./market_data";
import {
  runBacktest, makeSMACrossoverSignal, makeRSIMeanReversionSignal, makeBreakoutSignal, BarLike,
} from "./backtest_engine";

export const TRADING_SYSTEM_PROMPT = `You are a trading research assistant. You have access to:
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
backtest if asked. Always cite which strategy concept underlies your reasoning.`;

// ── Order proposal (safety boundary — drafts only, never executes) ──────────────
export interface OrderProposal {
  proposalId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit";
  limitPrice: number | null;
  assetClass: "equity" | "crypto";
  rationale: string;
  status: string;
}

const proposals = new Map<string, OrderProposal>();

export function proposeOrder(params: {
  symbol: string; side: "buy" | "sell"; quantity: number;
  assetClass?: "equity" | "crypto"; orderType?: "market" | "limit";
  limitPrice?: number | null; rationale: string;
}): OrderProposal {
  const { symbol, side, quantity, assetClass = "equity", orderType = "market", limitPrice = null, rationale } = params;
  if (side !== "buy" && side !== "sell") throw new Error(`side must be 'buy' or 'sell', got '${side}'`);
  if (quantity <= 0) throw new Error("quantity must be positive");
  if (orderType === "limit" && limitPrice == null) throw new Error("limitPrice is required for limit orders");

  const proposal: OrderProposal = {
    proposalId: randomUUID(),
    symbol: symbol.trim().toUpperCase(),
    side, quantity, orderType, limitPrice, assetClass, rationale,
    status: "PROPOSED — REQUIRES HUMAN CONFIRMATION",
  };
  proposals.set(proposal.proposalId, proposal);
  console.error(`[trading_agent] order proposed: ${JSON.stringify(proposal)}`);
  return proposal;
}

export function getProposal(proposalId: string): OrderProposal | undefined {
  return proposals.get(proposalId);
}

// ── IBKR execution (NOT auto-registered as an agent tool — explicit opt-in only) ─
export interface ExecutionResult {
  proposalId: string; mode: "PAPER" | "LIVE"; status: string;
  order: OrderProposal; note: string;
}

/**
 * Execute a previously-drafted order proposal via Interactive Brokers.
 * NOT registered in toolRegistry — the agent cannot call this autonomously.
 * Must be invoked directly by human-reviewed calling code after explicit review.
 */
export function orderExecuteIBKR(proposalId: string, confirm: boolean): ExecutionResult {
  if (confirm !== true) {
    throw new Error("Execution requires confirm=true from a human-reviewed call site. This is not optional and has no default override.");
  }
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error(`No proposal found with id '${proposalId}' — it may have expired or never existed`);

  const liveTrading = (process.env.IBKR_LIVE_TRADING ?? "").toLowerCase() === "true";
  const mode: "PAPER" | "LIVE" = liveTrading ? "LIVE" : "PAPER";

  if (liveTrading) {
    console.error(`[trading_agent] LIVE_ORDER_EXECUTION: ${JSON.stringify({ proposalId, ...proposal })}`);
  } else {
    console.error(`[trading_agent] paper_order_execution: ${JSON.stringify({ proposalId, ...proposal })}`);
  }

  return {
    proposalId, mode, status: "READY_FOR_BROKER_SUBMISSION", order: proposal,
    note: "This function validated and logged the confirmed order. Actual broker submission happens via the IBKR MCP connector at the integration layer, which must be invoked separately by the calling application.",
  };
}

// ── RAG engine ─────────────────────────────────────────────────────────────────
let _engine: RAGEngine | null = null;

async function getEngine(): Promise<RAGEngine> {
  if (!_engine) {
    _engine = new RAGEngine("trading_strategies");
    await _engine.init();
  }
  return _engine;
}

// ── Tool registration ────────────────────────────────────────────────────────────
export async function registerTradingTools(): Promise<void> {
  registerMarketDataTools();
  const engine = await getEngine();

  registerTool(
    { name: "rag_search", description: "Search the trading strategy knowledge base for theory on momentum, mean reversion, breakout, crypto, and risk management.",
      input_schema: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
    async ({ query, top_k }) => engine.retrieveAsContext(query as string, (top_k as number) ?? 5),
  );

  registerTool(
    { name: "run_backtest", description: "Backtest a named strategy preset against historical OHLCV data for a symbol. Presets: sma_crossover, rsi_mean_reversion, breakout.",
      input_schema: { type: "object", properties: {
        symbol: { type: "string" }, asset_class: { type: "string" }, strategy: { type: "string" },
        lookback_days_or_size: { type: "string" },
      }, required: ["symbol", "strategy"] } },
    async ({ symbol, strategy, asset_class, lookback_days_or_size }) => {
      try {
        const assetClass = (asset_class as string) ?? "equity";
        let bars: BarLike[];
        let barsPerYear: number;

        if (assetClass === "crypto") {
          const days = lookback_days_or_size && /^\d+$/.test(lookback_days_or_size as string)
            ? parseInt(lookback_days_or_size as string, 10) : 90;
          bars = await getCryptoOHLCV(symbol as string, "usd", days);
          barsPerYear = 365;
        } else {
          const size = (lookback_days_or_size === "compact" || lookback_days_or_size === "full")
            ? (lookback_days_or_size as "compact" | "full") : "compact";
          bars = await getStockOHLCV(symbol as string, "daily", size);
          barsPerYear = 252;
        }

        const strategyMap: Record<string, () => (h: BarLike[]) => "long" | "short" | "flat"> = {
          sma_crossover:      () => makeSMACrossoverSignal(),
          rsi_mean_reversion: () => makeRSIMeanReversionSignal(),
          breakout:            () => makeBreakoutSignal(),
        };
        const strategyKey = strategy as string;
        if (!(strategyKey in strategyMap)) {
          return `Error: unknown strategy '${strategyKey}'. Available: ${Object.keys(strategyMap).join(", ")}`;
        }

        const signalFn = strategyMap[strategyKey]();
        const result = runBacktest(bars, signalFn, { barsPerYear });

        return `Backtest of '${strategyKey}' on ${(symbol as string).toUpperCase()} (${bars.length} bars):\n` +
          `  Total Return: ${result.totalReturnPct.toFixed(2)}%\n` +
          `  Annualized Return: ${result.annualizedReturnPct.toFixed(2)}%\n` +
          `  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}\n` +
          `  Max Drawdown: ${result.maxDrawdownPct.toFixed(2)}%\n` +
          `  Win Rate: ${result.winRatePct.toFixed(1)}% (${result.numTrades} trades)\n` +
          `  Avg Trade: ${result.avgTradePct.toFixed(2)}% | Best: ${result.bestTradePct.toFixed(2)}% | Worst: ${result.worstTradePct.toFixed(2)}%`;
      } catch (e) {
        const msg = e instanceof MarketDataError || e instanceof Error ? e.message : String(e);
        return `Backtest failed: ${msg}`;
      }
    },
  );

  registerTool(
    { name: "order_propose", description: "Draft a proposed order for human review. NEVER executes a trade — only creates a proposal that requires explicit human confirmation to execute.",
      input_schema: { type: "object", properties: {
        symbol: { type: "string" }, side: { type: "string" }, quantity: { type: "number" },
        asset_class: { type: "string" }, order_type: { type: "string" }, limit_price: { type: "number" },
        rationale: { type: "string" },
      }, required: ["symbol", "side", "quantity", "rationale"] } },
    ({ symbol, side, quantity, asset_class, order_type, limit_price, rationale }) => {
      try {
        const proposal = proposeOrder({
          symbol: symbol as string, side: side as "buy" | "sell", quantity: quantity as number,
          assetClass: (asset_class as "equity" | "crypto") ?? "equity",
          orderType: (order_type as "market" | "limit") ?? "market",
          limitPrice: (limit_price as number) ?? null,
          rationale: rationale as string,
        });
        return `ORDER PROPOSAL (id=${proposal.proposalId}) — ${proposal.status}\n` +
          `  ${(side as string).toUpperCase()} ${quantity} ${(symbol as string).toUpperCase()} (${order_type ?? "market"})` +
          (order_type === "limit" ? ` @ limit $${limit_price}` : " @ market") +
          `\n  Rationale: ${rationale}\n` +
          `  This is a draft only. No order has been placed. A human must explicitly confirm and execute this proposal via the trading platform.`;
      } catch (e) {
        return `Error: invalid order parameters — ${e instanceof Error ? e.message : e}`;
      }
    },
  );

  console.error(`[trading_agent] tools registered, total=${toolRegistry.size}`);
}

export async function ingestStrategyKnowledge(knowledgeDir?: string): Promise<number> {
  const dir = knowledgeDir ?? path.resolve(__dirname, "../../../knowledge/trading_strategies");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`[trading_agent] knowledge dir missing: ${dir}`);
    return 0;
  }
  const docs = await loadDirectory(dir);
  if (!docs.length) {
    console.error(`[trading_agent] no strategy docs found in ${dir}`);
    return 0;
  }
  const engine = await getEngine();
  const count = await engine.ingest(docs);
  console.error(`[trading_agent] strategy knowledge ingested: ${docs.length} docs, ${count} chunks`);
  return count;
}

// ── CLI ────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let task = "Search the knowledge base for momentum strategies, then explain how a 50/200 SMA crossover works and what its main risk is.";
  let maxIterations = 20;
  let skipIngest = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) { task = args[i + 1]; i++; }
    else if (args[i] === "--max-iterations" && args[i + 1]) { maxIterations = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === "--skip-ingest") { skipIngest = true; }
  }

  if (!skipIngest) await ingestStrategyKnowledge();
  await registerTradingTools();

  const { answer, trace } = await runReact(task, { systemExtra: TRADING_SYSTEM_PROMPT, maxIterations });

  console.log("\n" + "=".repeat(64));
  console.log("TRADING AGENT — FINAL ANSWER");
  console.log("=".repeat(64));
  console.log(answer);
  console.log("=".repeat(64));
  console.log(`Iterations: ${trace.iterations} | Tokens: ${trace.totalTokens} | Time: ${trace.elapsedMs}ms`);

  if (proposals.size > 0) {
    console.log(`\n${proposals.size} order proposal(s) drafted this session (none executed):`);
    for (const p of proposals.values()) console.log(`  - ${JSON.stringify(p)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
