"use strict";

const router = require("express").Router();
const { adminAuthMiddleware } = require("../middleware/auth");
const { getAdminStatus, killAllProcesses } = require("../controllers");
const logger = require("../utils/logger");

router.get("/status", adminAuthMiddleware, (req, res, next) => {
  try { getAdminStatus(req, res); } catch (e) { next(e); }
});

router.delete("/kill-all", adminAuthMiddleware, (req, res, next) => {
  try { killAllProcesses(req, res); } catch (e) { next(e); }
});

module.exports = router;
