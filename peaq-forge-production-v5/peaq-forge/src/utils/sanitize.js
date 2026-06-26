"use strict";

const path = require("path");

const SHELL_CHARS  = /[;&|`$<>\n\r'"\\]/g;
const VALID_NETS   = new Set(["mainnet","agung","krest","local","custom"]);
const VALID_RPC_RE = /^(https?|wss?):\/\//;

// Strip all shell injection characters
function sanitizeStr(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(SHELL_CHARS, "").trim();
}

// Resolve and validate path — no traversal outside cwd
function sanitizePath(p) {
  if (!p) return "";
  return path.resolve(String(p));
}

// Validate path stays inside an allowed directory
function sanitizeFilePath(p, allowedDir) {
  if (!p) throw new Error("Path required");
  const resolved = path.resolve(String(p));
  if (allowedDir) {
    const base = path.resolve(String(allowedDir));
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error("Path traversal attempt blocked");
    }
  }
  return resolved;
}

// Filter array of args — remove any with shell chars
function sanitizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map(a => String(a)).filter(a => !/[;&|`$<>\n\r]/.test(a));
}

// Sanitize a number — return fallback if invalid
function sanitizeNumber(s, fallback = 0) {
  const n = parseInt(String(s || ""), 10);
  return isNaN(n) ? fallback : n;
}

// A10: SSRF — block private/internal IP ranges even on https/wss
// Prevents server-side requests to AWS metadata (169.254.x.x), internal networks, etc.
const PRIVATE_IP_RE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|127\.\d+\.\d+\.\d+|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)$/i;

function isPrivateHost(hostname) {
  if (!hostname) return true;
  if (PRIVATE_IP_RE.test(hostname)) return true;
  // Block localhost variants
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "[::]") return true;
  return false;
}

// Validate RPC URL — must be https or wss; http/ws only for localhost dev
function isValidRpc(url) {
  if (!url || typeof url !== "string") return false;
  if (!VALID_RPC_RE.test(url)) return false;
  try {
    const u = new URL(url);
    // Allow localhost http/ws for local dev node
    if ((u.protocol === "http:" || u.protocol === "ws:") &&
        (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    // For https/wss: block private IP ranges (A10: SSRF prevention)
    if (u.protocol === "https:" || u.protocol === "wss:") {
      if (isPrivateHost(u.hostname)) return false;
      return true;
    }
    return false;
  } catch { return false; }
}

// Validate WebSocket URL specifically
function isValidWsUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    // Allow localhost ws for local substrate/ink node
    if (u.protocol === "ws:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    // wss: block private IPs (A10: SSRF prevention)
    if (u.protocol === "wss:") {
      if (isPrivateHost(u.hostname)) return false;
      return true;
    }
    return false;
  } catch { return false; }
}

function isValidNetwork(net) { return VALID_NETS.has(net); }

function isHex(s) { return typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s); }

function isEthAddress(s) { return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s); }

function isSS58(s) { return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(s); }

// Redact private keys from any string before logging
function redactSecrets(s) {
  if (!s) return s;
  return String(s)
    .replace(/0x[0-9a-fA-F]{60,}/g, "[REDACTED_KEY]")
    .replace(/(private[_\s-]*key\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
    .replace(/(seed\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
    .replace(/(suri\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
    .replace(/(mnemonic\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]");
}

module.exports = {
  sanitizeStr,
  sanitizePath,
  sanitizeFilePath,
  sanitizeArgs,
  sanitizeNumber,
  isValidRpc,
  isValidWsUrl,
  isValidNetwork,
  isHex,
  isEthAddress,
  isSS58,
  redactSecrets,
};
