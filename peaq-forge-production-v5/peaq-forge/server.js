"use strict";

require("dotenv").config();
require("express-async-errors");

const http       = require("http");
const https      = require("https");
const fs         = require("fs");
const app        = require("./src/app");
const wsHandler  = require("./src/websocket/handler");
const logger     = require("./src/utils/logger");
const config     = require("./src/config");

// Use HTTPS if SSL certs provided, otherwise HTTP (localhost dev)
let server;
const SSL_KEY  = process.env.SSL_KEY_PATH;
const SSL_CERT = process.env.SSL_CERT_PATH;
if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
  server = https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app);
  logger.info("HTTPS mode enabled");
} else {
  server = http.createServer(app);
  logger.info("HTTP mode (localhost only). Set SSL_KEY_PATH and SSL_CERT_PATH for HTTPS.");
}
wsHandler.init(server);

function shutdown() {
  logger.info("Shutting down gracefully...");
  const { killAll } = require("./src/utils/runner");
  killAll();
  server.close(() => {
    logger.info("Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

process.on("uncaughtException", err => {
  logger.error("Uncaught exception: " + err.message, err);
  shutdown();
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection: " + reason);
});

server.listen(config.PORT, process.env.BIND_HOST || config.HOST, () => {
  logger.info("╔══════════════════════════════════════════════════════════════╗");
  logger.info("║   ◈  PEAQ FORGE v1 — peaq Network Dev Console               ║");
  logger.info(`║   URL:  http://${config.HOST}:${config.PORT}                              ║`);
  logger.info("║   Networks: peaq(3338) · Agung(9990) · Krest(2241) · Local  ║");
  logger.info("║   Modules:  EVM · Foundry · ink! · Substrate · DID · mNFT   ║");
  logger.info("║             Storage · RBAC                                   ║");
  logger.info("╠══════════════════════════════════════════════════════════════╣");
  logger.info(`║   AUTH TOKEN: ${config.AUTH_TOKEN.slice(0, 48)}   ║`);
  logger.info("╚══════════════════════════════════════════════════════════════╝");
});
