"use strict";

const router = require("express").Router();
const { getConfig } = require("../controllers");
const logger = require("../utils/logger");

router.get("/", (req, res, next) => {
  try { getConfig(req, res); } catch (e) { next(e); }
});

module.exports = router;
