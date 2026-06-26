"use strict";

require("express-async-errors");

const express    = require("express");
const helmet     = require("helmet");
const cors       = require("cors");
const path       = require("path");
const crypto     = require("crypto");
const { authMiddleware }           = require("./middleware/auth");
const { apiLimiter }               = require("./middleware/rateLimiter");
const { errorHandler, notFound }   = require("./middleware/errorHandler");
const apiRouter  = require("./routes/api");
const config     = require("./config");
const logger     = require("./utils/logger");

const app = express();
// A01: Only trust proxy headers when running behind a reverse proxy (TRUST_PROXY=1 in .env)
// Default false — prevents IP spoofing via X-Forwarded-For on localhost deployments
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.disable("x-powered-by");

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'sha256-EStyAQgBX7TrdsfXnBPgSPU3bTKxgqWkukdO8q2rjkk='", "'sha256-felC2PjcnxJ5ScVL034a7R+sOYP4+XJS1ME5vDOXW9I='", "https://fonts.googleapis.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      connectSrc:     ["'self'", "ws:", "wss:"],
      imgSrc:         ["'self'", "data:"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'none'"],   // A03: block base tag injection
      formAction:     ["'self'"],   // A03: block form hijacking
      upgradeInsecureRequests: [], // upgrade http→https where possible
    }
  },
  hsts:           { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "same-origin" },
  // A05: Permissions-Policy — lock down browser APIs not needed by this tool
  permissionsPolicy: {
    features: {
      camera:           [],
      microphone:       [],
      geolocation:      [],
      payment:          [],
      usb:              [],
      accelerometer:    [],
      gyroscope:        [],
      magnetometer:     [],
      displayCapture:   [],
      fullscreen:       ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false, // allow Google Fonts to load
  crossOriginResourcePolicy: { policy: "same-origin" },
}));

// ── CORS — localhost only ─────────────────────────────────────────────────────
// CORS - localhost in dev, configurable for hosting
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [`http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    logger.warn("CORS rejected origin: " + origin);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ── Request ID + logging ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  logger.info(`[${req.requestId}] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// ── Static files (frontend) ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ── Health check — no auth required ─────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now(), version: "1.0.0" }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api", apiLimiter, authMiddleware, apiRouter);

// ── Serve index.html for all other GET routes ─────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Error handlers ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
