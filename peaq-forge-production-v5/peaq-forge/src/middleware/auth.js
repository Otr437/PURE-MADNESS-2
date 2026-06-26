"use strict";

const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");

// Brute force protection
const failCounts  = new Map();
const FAIL_LIMIT  = 10;
const FAIL_WINDOW = 15 * 60 * 1000;

// A07: Clean up expired lockout records every 5 minutes
// Entries with until=0 (pre-threshold failures) expire immediately
// Entries with until>0 (locked out) expire after FAIL_WINDOW has passed
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of failCounts.entries()) {
    if (now > r.until + FAIL_WINDOW) failCounts.delete(ip);
  }
}, 5 * 60 * 1000).unref(); // unref so this interval doesn't keep process alive

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function authMiddleware(req, res, next) {
  const token = req.headers["x-forge-token"] || req.query._token;
  const ip    = (req.ip || "unknown").replace(/^::ffff:/, "");
  const now   = Date.now();

  const record = failCounts.get(ip);
  if (record && now < record.until) {
    const remaining = Math.ceil((record.until - now) / 60000);
    logger.warn(`Auth lockout from ${ip} — ${remaining}m remaining`);
    return res.status(429).json({ error: `Too many failed attempts. Wait ${remaining} minute(s).` });
  }

  if (!token || !timingSafeCompare(token, config.AUTH_TOKEN)) {
    const cur = failCounts.get(ip) || { count: 0, until: 0 };
    cur.count++;
    if (cur.count >= FAIL_LIMIT) {
      cur.until = now + FAIL_WINDOW;
      logger.warn(`Auth brute force lockout applied to ${ip}`);
    }
    failCounts.set(ip, cur);
    logger.warn(`Auth failed from ${ip} — ${req.method} ${req.path} attempt ${cur.count}`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Success — clear fail count
  failCounts.delete(ip);
  next();
}

function adminAuthMiddleware(req, res, next) {
  const token = req.headers["x-forge-admin"];
  const ip    = (req.ip || "unknown").replace(/^::ffff:/, "");
  if (!token || !timingSafeCompare(token, config.AUTH_TOKEN)) {
    logger.warn(`Admin auth failed from ${ip}`);
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

module.exports = { authMiddleware, adminAuthMiddleware, timingSafeCompare };
