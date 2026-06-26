// client/example.js — Production
import { X402Agent } from "./agent.js";
import winston       from "winston";
import fs            from "fs";
import path          from "path";
import dotenv        from "dotenv";
dotenv.config();

const LOG_DIR = process.env.LOG_DIR || "./logs";
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "x402-example" },
  transports: [
    new winston.transports.File({ filename: path.join(LOG_DIR, "example-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(LOG_DIR, "example.log") }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
  ],
});

const REQUIRED = ["AGENT_SECRET_KEY", "SERVER_URL", "STELLAR_NETWORK"];
const missing  = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) { logger.error("missing_env", { vars: missing }); process.exit(1); }

const SERVER    = process.env.SERVER_URL.replace(/\/$/, "");
const NETWORK   = process.env.STELLAR_NETWORK || "testnet";
const MAX_SPEND = parseInt(process.env.AGENT_MAX_SPEND_PER_REQ || "500000", 10);

if (isNaN(MAX_SPEND) || MAX_SPEND <= 0) { logger.error("invalid_max_spend", { AGENT_MAX_SPEND_PER_REQ: process.env.AGENT_MAX_SPEND_PER_REQ }); process.exit(1); }
if (!SERVER.startsWith("http")) { logger.error("invalid_server_url", { SERVER_URL: process.env.SERVER_URL }); process.exit(1); }

async function runAgent() {
  logger.info("agent_starting", { server: SERVER, network: NETWORK, maxSpendPerReq: MAX_SPEND });

  const agent = new X402Agent({
    secretKey:       process.env.AGENT_SECRET_KEY,
    networkName:     NETWORK,
    preferredToken:  "USDC",
    maxSpendPerReq:  MAX_SPEND,
    maxRetries:      1,
  });

  let hadError = false;

  try {
    const data = await agent.get(`${SERVER}/api/data`);
    logger.info("api_data_success", { response: data });
  } catch (e) {
    logger.error("api_data_failed", { error: e.message });
    hadError = true;
  }

  try {
    const premium = await agent.get(`${SERVER}/api/premium`);
    logger.info("api_premium_success", { response: premium });
  } catch (e) {
    logger.error("api_premium_failed", { error: e.message });
    hadError = true;
  }

  try {
    const inference = await agent.post(`${SERVER}/api/inference`, {
      prompt:    "Summarize the latest Stellar ecosystem news",
      maxTokens: 256,
      model:     "default",
    });
    logger.info("api_inference_success", { response: inference });
  } catch (e) {
    logger.error("api_inference_failed", { error: e.message });
    hadError = true;
  }

  const summary = agent.summary();
  logger.info("spend_summary", {
    totalRequests:   summary.totalRequests,
    totalSpent:      summary.totalSpent,
    remainingBudget: agent.remainingBudget().toString(),
    network:         summary.network,
    log:             summary.log,
  });

  if (hadError) { logger.error("agent_run_completed_with_errors"); process.exit(1); }
  logger.info("agent_run_complete");
}

process.on("uncaughtException",  (err) => { logger.error("uncaughtException",  { error: err.message, stack: err.stack }); process.exit(1); });
process.on("unhandledRejection", (err) => { logger.error("unhandledRejection", { error: err?.message }); process.exit(1); });

runAgent().catch((e) => { logger.error("fatal", { error: e.message }); process.exit(1); });
