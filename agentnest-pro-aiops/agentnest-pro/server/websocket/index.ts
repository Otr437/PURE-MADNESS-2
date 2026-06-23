import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import { queries, logEntry } from "../db/index.js";
import { mask } from "../services/crypto.js";

const clients = new Set<WebSocket>();

export function initWebSocket(wss: WebSocketServer, jwtSecret: string) {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Extract token from query string: ws://host?token=xxx
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Unauthorized: no token");
      return;
    }

    try {
      jwt.verify(token, jwtSecret);
    } catch {
      ws.close(4001, "Unauthorized: invalid token");
      return;
    }

    clients.add(ws);
    logEntry(null, null, "WebSocket client connected", "info", "system");

    // Send full initial state to newly connected client
    try {
      const agents    = (queries.getAllAgents.all() as any[]).map(sanitizeAgent);
      const tasks     = queries.getRecentTasks.all() as any[];
      const logs      = queries.getRecentLogs.all() as any[];
      const accounts  = (queries.getAllAccounts.all() as any[]).map(sanitizeAccount);
      const teams     = queries.getAllTeams.all() as any[];
      const workflows = queries.getAllWorkflows.all() as any[];
      const settings  = (queries.getAllSettings.all() as any[]).map(sanitizeSetting);

      // Gather all sub-tasks for recent tasks
      const taskIds = tasks.map((t: any) => t.id);
      const subTasks: any[] = [];
      for (const tid of taskIds) {
        const subs = queries.getSubTasksByTask.all(tid) as any[];
        subTasks.push(...subs);
      }

      ws.send(JSON.stringify({
        type: "INIT",
        data: { agents, tasks, logs: logs.reverse(), accounts, teams, workflows, subTasks, settings },
      }));
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "ERROR", data: { message: "Failed to load initial state" } }));
    }

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[WS] Client error:", err.message);
      clients.delete(ws);
    });
  });
}

export function broadcast(eventType: string, data: any) {
  const payload = JSON.stringify({ type: eventType, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  }
}

export function clientCount(): number {
  return clients.size;
}

// ─── Sanitize helpers: strip secrets before sending over wire ────────────────

export function sanitizeAgent(agent: any) {
  return {
    ...agent,
    capabilities: safeParseJSON(agent.capabilities, []),
  };
}

export function sanitizeAccount(account: any) {
  return {
    ...account,
    address_or_id: account.address_or_id ? mask(account.address_or_id) : null,
    spend_key:     account.spend_key     ? mask(account.spend_key)     : null,
    view_key:      account.view_key      ? mask(account.view_key)      : null,
  };
}

export function sanitizeSetting(setting: any) {
  return {
    ...setting,
    value: setting.is_secret ? mask(setting.value) : setting.value,
  };
}

function safeParseJSON(val: any, fallback: any) {
  try {
    return typeof val === "string" ? JSON.parse(val) : (val ?? fallback);
  } catch {
    return fallback;
  }
}
