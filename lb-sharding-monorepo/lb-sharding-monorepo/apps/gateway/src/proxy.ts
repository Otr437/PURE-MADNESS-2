// ============================================================
// apps/gateway — Reverse Proxy Handler
// ============================================================

import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendNode, Logger, RequestContext } from "@lb-sharding/core";
import type { GatewayConfig } from "./config.js";

export interface ProxyResult {
  statusCode: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export class ProxyHandler {
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly logger: Logger;
  private readonly config: GatewayConfig;

  constructor(config: GatewayConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "ProxyHandler" });

    const agentOpts = {
      keepAlive: config.proxy.keepAlive,
      maxSockets: config.proxy.maxSockets,
      maxFreeSockets: Math.floor(config.proxy.maxSockets / 4),
      timeout: config.loadBalancer.timeout.idleMs,
    };
    this.httpAgent = new http.Agent(agentOpts);
    this.httpsAgent = new https.Agent({ ...agentOpts, rejectUnauthorized: true });
  }

  async forward(
    ctx: RequestContext,
    node: BackendNode,
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
  ): Promise<ProxyResult> {
    const start = Date.now();
    const protocol = node.protocol === "https" ? "https" : "http";
    const target = `${protocol}://${node.host}:${node.port}${clientReq.url ?? "/"}`;

    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        method: clientReq.method ?? "GET",
        headers: this.buildHeaders(clientReq, ctx, node),
        agent: protocol === "https" ? this.httpsAgent : this.httpAgent,
        timeout: this.config.proxy.requestTimeoutMs,
      };

      const transport = protocol === "https" ? https : http;
      const proxyReq = transport.request(target, options, (proxyRes) => {
        const latencyMs = Date.now() - start;
        const statusCode = proxyRes.statusCode ?? 502;

        // Copy status + headers to client
        clientRes.writeHead(statusCode, this.filterResponseHeaders(proxyRes.headers));

        proxyRes.pipe(clientRes, { end: true });

        proxyRes.on("end", () => {
          resolve({
            statusCode,
            latencyMs,
            success: statusCode < 500,
          });
        });

        proxyRes.on("error", (e) => {
          this.logger.error("Proxy response error", { nodeId: node.id, error: e.message });
          resolve({ statusCode: 502, latencyMs: Date.now() - start, success: false, error: e.message });
        });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        if (!clientRes.headersSent) {
          clientRes.writeHead(504, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify({ error: "Gateway Timeout", requestId: ctx.id }));
        }
        resolve({ statusCode: 504, latencyMs: Date.now() - start, success: false, error: "timeout" });
      });

      proxyReq.on("error", (e) => {
        const latencyMs = Date.now() - start;
        this.logger.warn("Proxy request error", { nodeId: node.id, error: e.message, requestId: ctx.id });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify({ error: "Bad Gateway", requestId: ctx.id }));
        }
        resolve({ statusCode: 502, latencyMs, success: false, error: e.message });
      });

      // Pipe request body
      clientReq.pipe(proxyReq, { end: true });
    });
  }

  private buildHeaders(
    clientReq: IncomingMessage,
    ctx: RequestContext,
    node: BackendNode,
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };

    // Standard proxy headers
    const existingForwardedFor = clientReq.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = existingForwardedFor
      ? `${existingForwardedFor}, ${ctx.clientIp}`
      : ctx.clientIp;
    headers["x-forwarded-host"] = clientReq.headers["host"] ?? "";
    headers["x-forwarded-proto"] = node.protocol;
    headers["x-real-ip"] = ctx.clientIp;
    headers["x-request-id"] = ctx.id;

    // Remove hop-by-hop headers
    for (const h of HOP_BY_HOP) delete headers[h];

    return headers;
  }

  private filterResponseHeaders(
    headers: http.IncomingHttpHeaders,
  ): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) {
        out[k] = v as string;
      }
    }
    return out;
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
];
