"use strict";

const rateLimit = require("express-rate-limit");
const logger    = require("../utils/logger");

// Normalize IPv4-mapped IPv6 to prevent CVE-2026-30827 bypass
function normalizeIP(req) {
  return (req.ip || "unknown").replace(/^::ffff:/, "");
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizeIP,
  skip: (req) => req.path === "/api/health",
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded from ${normalizeIP(req)}`);
    res.status(429).json({ error: "Too many requests. Slow down." });
  }
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizeIP,
  handler: (req, res) => {
    logger.warn(`Strict rate limit exceeded from ${normalizeIP(req)}`);
    res.status(429).json({ error: "Too many requests." });
  }
});

module.exports = { apiLimiter, strictLimiter };
