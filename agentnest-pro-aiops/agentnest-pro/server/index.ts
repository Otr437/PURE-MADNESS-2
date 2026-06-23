import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { initWebSocket } from "./websocket/index.js";
import { initCrypto } from "./services/crypto.js";
import { startAgentLoop } from "./services/agentLoop.js";
import { setJwtSecret, apiLimiter } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { agentsRouter } from "./routes/agents.js";
import { tasksRouter } from "./routes/tasks.js";
import { workflowsRouter } from "./routes/workflows.js";
import { settingsRouter } from "./routes/settings.js";
import { chatRouter } from "./routes/chat.js";
import { logsRouter }        from "./routes/logs.js";
import { memoryRouter }      from "./routes/memory.js";
import { checkpointsRouter } from "./routes/checkpoints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT     = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD  = NODE_ENV === "production";

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const g = crypto.randomBytes(64).toString("hex");
  if (IS_PROD) console.warn("[SECURITY] JWT_SECRET not set — sessions will reset on restart. Set JWT_SECRET in .env");
  return g;
})();

initCrypto(JWT_SECRET);
setJwtSecret(JWT_SECRET);

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: IS_PROD ? (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean) : "*", credentials: true }));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use("/api/", apiLimiter);

initWebSocket(wss, JWT_SECRET);

app.use("/api/auth",      authRouter(JWT_SECRET));
app.use("/api/agents",    agentsRouter);
app.use("/api/tasks",     tasksRouter);
app.use("/api/workflows", workflowsRouter);
app.use("/api/settings",  settingsRouter);
app.use("/api/chat",      chatRouter);
app.use("/api/logs",        logsRouter);
app.use("/api/memory",      memoryRouter);
app.use("/api/checkpoints", checkpointsRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", environment: NODE_ENV, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Serve the single HTML frontend — no React, no build step needed
const frontendPath = path.join(__dirname, "../index.html");
app.get("*", (_req, res) => res.sendFile(frontendPath));

startAgentLoop();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║     AgentNest Pro — Production Server         ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  URL:         http://localhost:${PORT}`);
  console.log(`  Frontend:    Vanilla HTML/JS (no framework)`);
  console.log(`  Environment: ${NODE_ENV}`);
  console.log(`  Security:    AES-256 ✓  JWT ✓  Helmet ✓  Rate-limit ✓`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

const shutdown = (sig: string) => {
  console.log(`[Server] ${sig} — shutting down…`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
