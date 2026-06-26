"use strict";

const router  = require("express").Router();
const logger  = require("../utils/logger");
const { getNetworkHealth, getNetworkStatus } = require("../controllers");

// Health check — no auth required
router.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now(), version: "1.0.0" });
});

// All other API routes
router.use("/tools",       require("./tools"));
router.use("/contracts",   require("./contracts"));
router.use("/config",      require("./config"));
router.use("/deployments", require("./deployments"));
router.use("/admin",       require("./admin"));

// Network health endpoints
router.get("/network/health",       async (_req, res, next) => { try { await getNetworkHealth(_req, res); } catch(e) { next(e); } });
router.get("/network/:network",     async (req, res, next) => {
  const allowed = ["mainnet","agung","krest"];
  if (!allowed.includes(req.params.network)) return res.status(400).json({ error: "Unknown network" });
  try { await getNetworkStatus(req, res); } catch(e) { next(e); }
});

// Catch-all for unknown API routes
router.use((req, res) => {
  logger.warn(`Unknown API route: ${req.method} ${req.path}`);
  res.status(404).json({ error: "API route not found" });
});

module.exports = router;
