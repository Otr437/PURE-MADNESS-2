// ============================================================
// apps/gateway — Metrics Server (Prometheus scrape endpoint)
// ============================================================

import * as http from "node:http";
import type { MetricsRegistry } from "@lb-sharding/metrics";
import type { Logger } from "@lb-sharding/core";
import type { GatewayConfig } from "./config.js";

export class MetricsServer {
  private readonly server: http.Server;

  constructor(
    private readonly registry: MetricsRegistry,
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {
    this.server = http.createServer((req, res) => {
      const url = req.url?.split("?")[0];
      if (url === "/metrics") {
        const body = registry.toPrometheus();
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.server.metricsPort, this.config.server.host, () => {
        this.logger.info("Metrics server listening", { port: this.config.server.metricsPort });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((e) => (e ? reject(e) : resolve()));
    });
  }
}
