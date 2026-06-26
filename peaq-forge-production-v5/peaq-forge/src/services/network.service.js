"use strict";

const https  = require("https");
const http   = require("http");
const WebSocket = require("ws");
const config = require("../config");
const logger = require("../utils/logger");

const TIMEOUT_MS = 8000;

/**
 * Probe an HTTP/HTTPS RPC endpoint with eth_chainId.
 * Returns { ok, chainId, latencyMs, error }
 */
function probeRpc(url) {
  return new Promise(resolve => {
    const start = Date.now();
    const body  = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 });
    let resolved = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve({ latencyMs: Date.now() - start, ...result });
    };

    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), TIMEOUT_MS);

    try {
      const parsed  = new URL(url);
      const mod     = parsed.protocol === "https:" ? https : http;
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname || "/",
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout:  TIMEOUT_MS,
      };

      const req = mod.request(options, res => {
        let data = "";
        res.on("data", d => { data += d; });
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            const chainId = json.result ? parseInt(json.result, 16) : null;
            done({ ok: res.statusCode === 200 && chainId !== null, chainId, rawStatus: res.statusCode });
          } catch (e) {
            done({ ok: false, error: "invalid JSON response" });
          }
        });
      });

      req.on("error", err => { clearTimeout(timer); done({ ok: false, error: err.message }); });
      req.on("timeout", ()  => { req.destroy(); clearTimeout(timer); done({ ok: false, error: "timeout" }); });
      req.write(body);
      req.end();
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, error: e.message });
    }
  });
}

/**
 * Probe a WebSocket endpoint with system_chain.
 * Returns { ok, chain, latencyMs, error }
 */
function probeWs(url) {
  return new Promise(resolve => {
    const start    = Date.now();
    let resolved   = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve({ latencyMs: Date.now() - start, ...result });
    };

    const timer = setTimeout(() => { done({ ok: false, error: "timeout" }); try { ws.terminate(); } catch {} }, TIMEOUT_MS);

    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS });
    } catch (e) {
      clearTimeout(timer);
      return done({ ok: false, error: e.message });
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "system_chain", params: [] }));
    });

    ws.on("message", data => {
      clearTimeout(timer);
      try {
        const json  = JSON.parse(data.toString());
        const chain = json.result || null;
        done({ ok: true, chain });
      } catch {
        done({ ok: false, error: "invalid JSON" });
      }
      try { ws.close(); } catch {}
    });

    ws.on("error", err => {
      clearTimeout(timer);
      done({ ok: false, error: err.message });
      try { ws.terminate(); } catch {}
    });
  });
}

/**
 * Check all configured networks.
 * Returns array of network health objects.
 */
async function checkAllNetworks() {
  const networks = [
    { name: "mainnet", chainId: 3338, rpc: config.NETWORKS.mainnet.rpc, ws: config.NETWORKS.mainnet.ws },
    { name: "agung",   chainId: 9990, rpc: config.NETWORKS.agung.rpc,   ws: config.NETWORKS.agung.ws   },
    { name: "krest",   chainId: 2241, rpc: config.NETWORKS.krest.rpc,   ws: config.NETWORKS.krest.ws   },
  ];

  const results = await Promise.all(networks.map(async net => {
    const [rpcResult, wsResult] = await Promise.all([
      probeRpc(net.rpc).catch(e => ({ ok: false, error: e.message })),
      probeWs(net.ws).catch(e  => ({ ok: false, error: e.message })),
    ]);

    const rpcChainMatch = rpcResult.chainId === net.chainId;

    return {
      network:       net.name,
      expectedChain: net.chainId,
      rpc: {
        url:        net.rpc,
        ok:         rpcResult.ok,
        chainId:    rpcResult.chainId ?? null,
        chainMatch: rpcChainMatch,
        latencyMs:  rpcResult.latencyMs,
        error:      rpcResult.error || null,
      },
      ws: {
        url:       net.ws,
        ok:        wsResult.ok,
        chain:     wsResult.chain || null,
        latencyMs: wsResult.latencyMs,
        error:     wsResult.error || null,
      },
      healthy: rpcResult.ok && wsResult.ok,
    };
  }));

  logger.info(`Network health check complete — ${results.filter(r => r.healthy).length}/${results.length} healthy`);
  return results;
}

/**
 * Quick single-network probe for liveness check.
 */
async function checkNetwork(networkName) {
  const net = config.NETWORKS[networkName];
  if (!net) throw new Error(`Unknown network: ${networkName}`);
  const rpcResult = await probeRpc(net.rpc);
  return { network: networkName, rpc: rpcResult, healthy: rpcResult.ok };
}

module.exports = { checkAllNetworks, checkNetwork, probeRpc, probeWs };
