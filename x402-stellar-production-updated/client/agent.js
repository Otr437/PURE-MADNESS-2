// client/agent.js
// x402 Agent Client for Stellar — Production
// Autonomous agent that discovers, validates, pays, and retries x402-protected endpoints.
// Full spend controls, retry logic, error handling, and audit logging.

import axios   from "axios";
import winston from "winston";
import fs      from "fs";
import path    from "path";

const LOG_DIR = process.env.LOG_DIR || "./logs";
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: "x402-agent" },
  transports: [
    new winston.transports.File({ filename: path.join(LOG_DIR, "agent.log") }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
  ],
});
import { encodePaymentHeader, generateNonce, isValidStellarAddress, isSupportedToken } from "../shared/types.js";
import { buildSignedAuthEntry, validateAuthPayload } from "../shared/stellar-signer.js";

// Hard ceiling on spend per session — protects against runaway agents
const ABSOLUTE_SESSION_LIMIT = BigInt(process.env.AGENT_SESSION_LIMIT || "10000000"); // 1 USDC default

export class X402Agent {
  /**
   * @param {object} opts
   * @param {string} opts.secretKey          - Agent's Stellar secret key
   * @param {"testnet"|"mainnet"} opts.networkName
   * @param {"USDC"|"USDT"} opts.preferredToken
   * @param {number} opts.maxSpendPerReq     - Max spend per single request in base units
   * @param {number} opts.maxRetries         - Max payment retries per request (default 1)
   * @param {number} opts.requestTimeoutMs   - HTTP request timeout in ms (default 30000)
   */
  constructor({
    secretKey,
    networkName     = "testnet",
    preferredToken  = "USDC",
    maxSpendPerReq  = 1_000_000,   // 0.1 USDC
    maxRetries      = 1,
    requestTimeoutMs = 30_000,
  }) {
    // ── Validate constructor inputs ────────────────────────────────────────────
    if (!secretKey || typeof secretKey !== "string") {
      throw new Error("X402Agent: secretKey is required");
    }
    if (!secretKey.startsWith("S") || secretKey.length !== 56) {
      throw new Error("X402Agent: secretKey must be a valid Stellar secret key (S...)");
    }
    if (!["testnet", "mainnet"].includes(networkName)) {
      throw new Error(`X402Agent: unknown networkName "${networkName}"`);
    }
    if (!isSupportedToken(preferredToken)) {
      throw new Error(`X402Agent: unsupported preferredToken "${preferredToken}"`);
    }
    if (typeof maxSpendPerReq !== "number" || maxSpendPerReq <= 0) {
      throw new Error("X402Agent: maxSpendPerReq must be a positive number");
    }
    if (maxRetries < 0 || maxRetries > 5) {
      throw new Error("X402Agent: maxRetries must be between 0 and 5");
    }

    this.secretKey       = secretKey;
    this.networkName     = networkName;
    this.preferredToken  = preferredToken;
    this.maxSpendPerReq  = BigInt(maxSpendPerReq);
    this.maxRetries      = maxRetries;
    this.spendingLog     = [];
    this.totalSpent      = 0n;
    this.sessionStart    = new Date().toISOString();

    // Axios instance with timeout
    this._http = axios.create({ timeout: requestTimeoutMs });
  }

  /**
   * Fetch a URL, automatically handling 402 by paying and retrying.
   * Never pays more than maxSpendPerReq per request.
   * Never exceeds ABSOLUTE_SESSION_LIMIT across the session.
   *
   * @param {string} url
   * @param {object} [axiosConfig]
   * @returns {Promise<object>} Response data
   * @throws {Error} On network error, payment failure, or spend limit breach
   */
  async fetch(url, axiosConfig = {}) {
    if (!url || typeof url !== "string") {
      throw new Error("X402Agent.fetch: url is required");
    }
    // Validate URL format
    try { new URL(url); } catch {
      throw new Error(`X402Agent.fetch: invalid URL "${url}"`);
    }

    // Session spend guard
    if (this.totalSpent >= ABSOLUTE_SESSION_LIMIT) {
      throw new Error(
        `X402Agent: session spend limit reached (${ABSOLUTE_SESSION_LIMIT.toString()} base units). ` +
        `Create a new agent instance to continue.`
      );
    }

    // Initial request — no payment header
    let response;
    try {
      response = await this._http({ url, ...axiosConfig, validateStatus: null });
    } catch (err) {
      throw new Error(`X402Agent: network error fetching ${url}: ${err.message}`);
    }

    // Not a payment required response — return as-is
    if (response.status !== 402) {
      if (response.status >= 500) {
        throw new Error(`X402Agent: server error ${response.status} from ${url}`);
      }
      return response.data;
    }

    // ── 402 received — parse and validate requirements ─────────────────────────
    const requirements = response.data?.requirements;
    if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
      throw new Error(`X402Agent: 402 from ${url} but no payment requirements in response`);
    }

    const offer = this._selectOffer(requirements);
    if (!offer) {
      const available = requirements.flatMap((r) => r.accepts?.map((a) => a.tokenSymbol) || []);
      throw new Error(
        `X402Agent: no acceptable offer at ${url}. ` +
        `Preferred: ${this.preferredToken}. Available: ${[...new Set(available)].join(", ")}`
      );
    }

    const { contractId, price, tokenSymbol, facilitator, resource } = offer;

    // Per-request spend guard
    if (BigInt(price) > this.maxSpendPerReq) {
      throw new Error(
        `X402Agent: price ${price} ${tokenSymbol} exceeds per-request limit ${this.maxSpendPerReq.toString()}`
      );
    }

    // Session ceiling check including this payment
    if (this.totalSpent + BigInt(price) > ABSOLUTE_SESSION_LIMIT) {
      throw new Error(
        `X402Agent: this payment would exceed session spend limit. ` +
        `Spent: ${this.totalSpent}, Price: ${price}, Limit: ${ABSOLUTE_SESSION_LIMIT}`
      );
    }

    // ── Build and sign payment ────────────────────────────────────────────────
    const nonce = await generateNonce();

    let authPayload;
    try {
      authPayload = await buildSignedAuthEntry({
        signerSecretKey: this.secretKey,
        contractId,
        tokenSymbol,
        amount:      price,
        nonce,
        resource:    resource || new URL(url).pathname,
        networkName: this.networkName,
      });
    } catch (err) {
      throw new Error(`X402Agent: failed to build payment for ${url}: ${err.message}`);
    }

    // Sanity check the payload before encoding
    const { valid, errors } = validateAuthPayload(authPayload);
    if (!valid) {
      throw new Error(`X402Agent: built payload failed validation: ${errors.join("; ")}`);
    }

    const paymentHeader = encodePaymentHeader(authPayload);

    // ── Retry with payment header — with retry loop ───────────────────────────
    let paidResponse;
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff between retries
        await this._sleep(500 * Math.pow(2, attempt - 1));
        logger.warn("agent_retry", { attempt, maxRetries: this.maxRetries, url });
      }

      try {
        paidResponse = await this._http({
          url,
          ...axiosConfig,
          headers: {
            ...(axiosConfig.headers || {}),
            "X-Payment": paymentHeader,
          },
          validateStatus: null,
        });
      } catch (err) {
        lastError = err;
        continue;
      }

      if (paidResponse.status === 402) {
        lastError = new Error(`Payment rejected: ${JSON.stringify(paidResponse.data)}`);
        continue;
      }

      if (paidResponse.status >= 500) {
        lastError = new Error(`Server error ${paidResponse.status} after payment`);
        continue;
      }

      // Success
      break;
    }

    if (!paidResponse || paidResponse.status === 402 || paidResponse.status >= 500) {
      throw lastError || new Error(`X402Agent: paid request to ${url} failed after ${this.maxRetries} retries`);
    }

    // ── Log spend ─────────────────────────────────────────────────────────────
    const logEntry = {
      url,
      resource:  resource || new URL(url).pathname,
      token:     tokenSymbol,
      amount:    price,
      nonce,
      status:    paidResponse.status,
      timestamp: new Date().toISOString(),
    };
    this.spendingLog.push(logEntry);
    this.totalSpent += BigInt(price);

    logger.info("agent_payment", { price, token: tokenSymbol, resource: logEntry.resource, sessionTotal: this.totalSpent.toString() });

    return paidResponse.data;
  }

  /** GET shorthand */
  async get(url, params = {}) {
    return this.fetch(url, { method: "GET", params });
  }

  /** POST shorthand */
  async post(url, data = {}) {
    return this.fetch(url, { method: "POST", data });
  }

  /**
   * Select best offer from requirements.
   * Priority: preferred token first, then lowest price.
   * Returns null if no viable offer found.
   */
  _selectOffer(requirements) {
    const allOffers = requirements.flatMap((req) =>
      (req.accepts || []).map((a) => ({ ...a }))
    );

    // Filter to tokens we can pay with
    const viable = allOffers.filter(
      (o) => o.tokenSymbol === this.preferredToken ||
             o.tokenSymbol === "USDC" ||
             o.tokenSymbol === "USDT"
    );

    if (viable.length === 0) return null;

    // Prefer our preferred token
    const preferred = viable.filter((o) => o.tokenSymbol === this.preferredToken);
    const pool = preferred.length > 0 ? preferred : viable;

    // Lowest price within the pool
    return pool.sort((a, b) => {
      const diff = BigInt(a.price) - BigInt(b.price);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    })[0];
  }

  /** Spending summary for this session */
  summary() {
    return {
      sessionStart:   this.sessionStart,
      totalRequests:  this.spendingLog.length,
      totalSpent:     this.totalSpent.toString(),
      preferredToken: this.preferredToken,
      network:        this.networkName,
      log:            this.spendingLog,
    };
  }

  /** Check remaining session budget */
  remainingBudget() {
    const remaining = ABSOLUTE_SESSION_LIMIT - this.totalSpent;
    return remaining > 0n ? remaining : 0n;
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

// ── Process-level guards ──────────────────────────────────────────────────────
process.on("uncaughtException",  (err) => { logger.error("uncaughtException",  { error: err.message, stack: err.stack }); process.exit(1); });
process.on("unhandledRejection", (err) => { logger.error("unhandledRejection", { error: err?.message }); process.exit(1); });
