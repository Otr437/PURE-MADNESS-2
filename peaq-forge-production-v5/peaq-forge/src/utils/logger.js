"use strict";

const winston = require("winston");
const path    = require("path");
const fs      = require("fs");
const config  = require("../config");

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), "logs");
try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch {}

// Redact secrets from log messages
const redactFormat = winston.format((info) => {
  if (typeof info.message === "string") {
    info.message = info.message
      .replace(/0x[0-9a-fA-F]{60,}/g, "[REDACTED_KEY]")
      .replace(/(private[_\s-]*key\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
      .replace(/(seed\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
      .replace(/(suri\s*[=:]\s*)[^\s&]*/gi, "$1[REDACTED]")
      .replace(/(token\s*[=:]\s*)[a-f0-9]{32,}/gi, "$1[REDACTED]");
  }
  return info;
});

const logger = winston.createLogger({
  level: config.LOG_LEVEL || "info",
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return stack
        ? `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`
        : `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === "test",
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level:    "error",
      maxsize:  5 * 1024 * 1024, // 5MB
      maxFiles: 3,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize:  10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: path.join(logsDir, "exceptions.log") }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: path.join(logsDir, "rejections.log") }),
  ],
});

module.exports = logger;
