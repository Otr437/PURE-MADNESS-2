"use strict";

const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const reqId   = req.requestId || "unknown";
  logger.error(`[${reqId}] Error ${status}: ${err.message}`, err);

  // Never expose stack traces or internal details in production
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message;

  res.status(status).json({ error: message, requestId: reqId });
}

function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

module.exports = { errorHandler, notFound };
