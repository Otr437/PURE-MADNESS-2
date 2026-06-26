"use strict";

const { describe, it, before, after } = require("node:test");
const assert  = require("node:assert/strict");
const http    = require("http");

process.env.PEAQ_FORGE_TOKEN   = "integration-test-token";
process.env.NODE_ENV           = "test";
process.env.PORT               = "3099";
process.env.PEAQ_FORGE_LOG_FILE = require("os").tmpdir() + "/peaq_forge_test_" + Date.now() + ".json";

let server;

before(async () => {
  require("dotenv").config();
  const app       = require("../../src/app");
  const wsHandler = require("../../src/websocket/handler");
  server = http.createServer(app);
  wsHandler.init(server);
  await new Promise(resolve => server.listen(3099, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { require("fs").unlinkSync(process.env.PEAQ_FORGE_LOG_FILE); } catch {}
});

const TOKEN = "integration-test-token";
const WRONG = "wrong-token";

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: "127.0.0.1",
      port:     3099,
      path,
      method,
      headers: {
        ...(token ? { "x-forge-token": token } : {}),
        ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: raw, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const get  = (path, token)        => request("GET",    path, token);
const del  = (path, token)        => request("DELETE", path, token);
const post = (path, token, body)  => request("POST",   path, token, body);

// ── Health ────────────────────────────────────────────────────────────────────
describe("Health check — no auth", () => {
  it("GET /api/health returns 200 without token", async () => {
    const r = await get("/api/health", null);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
    assert.ok(typeof r.body.ts === "number");
    assert.ok(r.body.version);
  });
});

// ── Authentication ─────────────────────────────────────────────────────────────
describe("Authentication", () => {
  it("returns 401 without token", async () => {
    const r = await get("/api/deployments", null);
    assert.equal(r.status, 401);
    assert.ok(r.body.error);
  });

  it("returns 401 with wrong token", async () => {
    const r = await get("/api/deployments", WRONG);
    assert.equal(r.status, 401);
  });

  it("returns 200 with correct token", async () => {
    const r = await get("/api/deployments", TOKEN);
    assert.equal(r.status, 200);
  });

  it("sets X-Request-ID header on all responses", async () => {
    const r = await get("/api/health", null);
    assert.ok(r.headers["x-request-id"], "should have X-Request-ID");
  });
});

// ── Tools ─────────────────────────────────────────────────────────────────────
describe("GET /api/tools", () => {
  it("returns tools array with correct shape", async () => {
    const r = await get("/api/tools", TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.tools));
    assert.ok(r.body.tools.length > 0);
    for (const t of r.body.tools) {
      assert.ok(typeof t.name === "string");
      assert.ok(typeof t.available === "boolean");
      assert.ok(typeof t.version === "string");
    }
  });

  it("always includes node in tools list", async () => {
    const r = await get("/api/tools", TOKEN);
    const node = r.body.tools.find(t => t.name === "node");
    assert.ok(node, "node should be in tools list");
    assert.equal(node.available, true);
  });
});

// ── Deployments ───────────────────────────────────────────────────────────────
describe("Deployments", () => {
  it("GET returns deployments array", async () => {
    const r = await get("/api/deployments", TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.deployments));
    assert.ok(typeof r.body.count === "number");
  });

  it("DELETE clears deployments", async () => {
    const r = await del("/api/deployments", TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const check = await get("/api/deployments", TOKEN);
    assert.equal(check.body.count, 0);
  });

  it("DELETE requires auth", async () => {
    const r = await del("/api/deployments", null);
    assert.equal(r.status, 401);
  });
});

// ── Config ────────────────────────────────────────────────────────────────────
describe("GET /api/config", () => {
  it("returns exists:false for nonexistent dir", async () => {
    const r = await get("/api/config?chain=peaq&dir=/nonexistent_path_xyz_abc", TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.exists, false);
  });

  it("requires auth", async () => {
    const r = await get("/api/config", null);
    assert.equal(r.status, 401);
  });
});

// ── Contracts ─────────────────────────────────────────────────────────────────
describe("GET /api/contracts", () => {
  it("returns contracts array for nonexistent dir gracefully", async () => {
    const r = await get("/api/contracts?chain=peaq&dir=/nonexistent_xyz", TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.contracts));
  });

  it("rejects unknown chain", async () => {
    const r = await get("/api/contracts?chain=badchain&dir=/tmp", TOKEN);
    assert.equal(r.status, 400);
  });

  it("requires auth", async () => {
    const r = await get("/api/contracts", null);
    assert.equal(r.status, 401);
  });
});

// ── ABI ───────────────────────────────────────────────────────────────────────
describe("GET /api/contracts/abi", () => {
  it("returns 400 without path param", async () => {
    const r = await get("/api/contracts/abi", TOKEN);
    assert.equal(r.status, 400);
  });

  it("returns 404 for nonexistent file", async () => {
    const r = await get("/api/contracts/abi?path=/tmp/nonexistent_abc.json", TOKEN);
    assert.equal(r.status, 404);
  });

  it("returns 400 for disallowed extension", async () => {
    const r = await get("/api/contracts/abi?path=/tmp/test.sh", TOKEN);
    assert.equal(r.status, 400);
  });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
describe("Admin routes", () => {
  it("GET /api/admin/status requires admin header", async () => {
    const r = await get("/api/admin/status", TOKEN);
    assert.equal(r.status, 403);
  });

  it("GET /api/admin/status returns server info with admin header", async () => {
    const r = await request("GET", "/api/admin/status", TOKEN, null);
    // Need to add x-forge-admin header
    const r2 = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: 3099, path: "/api/admin/status", method: "GET",
        headers: { "x-forge-token": TOKEN, "x-forge-admin": TOKEN },
      }, res => {
        let raw = "";
        res.on("data", d => { raw += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.status, "ok");
    assert.ok(typeof r2.body.uptime === "number");
    assert.ok(typeof r2.body.memory === "object");
    assert.ok(typeof r2.body.activeProcesses === "number");
  });
});

// ── Network health ─────────────────────────────────────────────────────────────
describe("GET /api/network/health", () => {
  it("returns networks array", async () => {
    // This makes real network calls — give it time
    const r = await get("/api/network/health", TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.networks));
    assert.equal(r.body.networks.length, 3);
    for (const n of r.body.networks) {
      assert.ok(typeof n.network === "string");
      assert.ok(typeof n.healthy === "boolean");
      assert.ok(n.rpc);
      assert.ok(n.ws);
    }
  });
});

describe("GET /api/network/:network", () => {
  it("returns 400 for unknown network", async () => {
    const r = await get("/api/network/badnet", TOKEN);
    assert.equal(r.status, 400);
  });

  it("accepts known network names", async () => {
    const r = await get("/api/network/agung", TOKEN);
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.healthy === "boolean");
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────
describe("Unknown routes", () => {
  it("returns 404 for unknown API route", async () => {
    const r = await get("/api/notaroute", TOKEN);
    assert.equal(r.status, 404);
  });

  it("returns 200 serving index.html for unknown non-API GET", async () => {
    const r = await get("/some/frontend/route", null);
    assert.equal(r.status, 200);
  });
});
