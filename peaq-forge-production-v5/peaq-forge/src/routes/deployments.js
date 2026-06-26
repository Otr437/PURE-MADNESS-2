"use strict";

const router = require("express").Router();
const { getDeployments, clearDeployments } = require("../controllers");
const logger = require("../utils/logger");

router.get("/", (req, res, next) => {
  try { getDeployments(req, res); } catch (e) { next(e); }
});

router.delete("/", (req, res, next) => {
  try { clearDeployments(req, res); } catch (e) { next(e); }
});

module.exports = router;
