// ============================================================
// MODULE 12: LOCAL FRONTEND SERVER
// Role: Serves the local blockchain operations dashboard.
//       Static HTML/JS/CSS served from /public.
//       WebSocket proxy for real-time events from module9.
//       WalletConnect + MetaMask integration via injected provider.
// Port: 3012
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, writeFile } from 'fs/promises';
import crypto from 'crypto';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.FRONTEND_PUBLIC_DIR ?? join(__dirname, '../frontend/public');
const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
});

await fastify.register(cors, { origin: '*' });

// Serve static files
await fastify.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
  decorateReply: true,
});

// ── WebSocket server for real-time event relay ────────────────
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', timestamp: getTodayISO() }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcastToClients(data: unknown) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── SSE relay from module9 ────────────────────────────────────

let eventRelayActive = false;
async function startEventRelay() {
  if (eventRelayActive) return;
  eventRelayActive = true;
  const eventsUrl = `${getServiceUrl('module9-events')}/stream`;
  const reconnect = async () => {
    try {
      const res = await fetch(eventsUrl, {
        headers: { [INTERNAL_HEADER]: process.env.INTERNAL_SERVICE_TOKEN! },
      });
      if (!res.body) throw new Error('No body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          try {
            const event = JSON.parse(line.slice(6));
            broadcastToClients({ type: 'event', data: event });
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* connection dropped */ }
    // Reconnect after 3s
    await new Promise(r => setTimeout(r, 3_000));
    void reconnect();
  };
  void reconnect();
}

// ── API proxy routes ──────────────────────────────────────────

// Proxy all /api/* requests to the appropriate backend module
fastify.all('/api/*', async (req: FastifyRequest, reply: FastifyReply) => {
  const url = req.url.replace('/api', '');
  const auth = req.headers.authorization;

  // Route by path prefix
  let targetUrl: string;
  if (url.startsWith('/blockchain')) {
    targetUrl = `${getServiceUrl('module11-blockchain')}${url.replace('/blockchain', '')}`;
  } else if (url.startsWith('/auth')) {
    targetUrl = `${getServiceUrl('module4-gateway')}${url}`;
  } else if (url.startsWith('/tasks') || url.startsWith('/run') || url.startsWith('/status') || url.startsWith('/stats')) {
    targetUrl = `${getServiceUrl('module4-gateway')}${url}`;
  } else if (url.startsWith('/admin')) {
    targetUrl = `${getServiceUrl('module4-gateway')}${url}`;
  } else if (url.startsWith('/events')) {
    targetUrl = `${getServiceUrl('module4-gateway')}${url}`;
  } else {
    return reply.status(404).send({ error: `No API route for ${url}` });
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = auth;

    const res = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });

    const contentType = res.headers.get('content-type') ?? 'application/json';
    reply.header('Content-Type', contentType);
    return reply.status(res.status).send(await res.text());
  } catch (err) {
    return reply.status(502).send({ error: `Proxy error: ${String(err).slice(0, 200)}` });
  }
});

fastify.get('/health', async () => ({
  service: 'module12-frontend',
  status: 'online',
  date: getTodayDate(),
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  wsClients: wsClients.size,
}));

// ── Serve index.html for all non-API routes (SPA) ────────────
fastify.setNotFoundHandler(async (_req, reply) => {
  return reply.sendFile('index.html');
});

// ── Build the static HTML dashboard ──────────────────────────
async function buildFrontend() {
  await mkdir(PUBLIC_DIR, { recursive: true });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>AI Blockchain Ops</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0b0e; --bg2: #13141a; --bg3: #1c1e27;
    --border: #2a2d3a; --accent: #6366f1; --accent2: #8b5cf6;
    --green: #22c55e; --red: #ef4444; --yellow: #f59e0b; --blue: #3b82f6;
    --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b;
    --radius: 8px; --font: 'Inter', system-ui, sans-serif;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; }
  #app { display: grid; grid-template-columns: 220px 1fr; grid-template-rows: 56px 1fr; height: 100vh; }
  header { grid-column: 1/-1; display: flex; align-items: center; padding: 0 20px; background: var(--bg2); border-bottom: 1px solid var(--border); gap: 16px; }
  header h1 { font-size: 16px; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  #ws-status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); }
  #ws-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); transition: background .3s; }
  #ws-dot.connected { background: var(--green); }
  nav { background: var(--bg2); border-right: 1px solid var(--border); padding: 16px 0; overflow-y: auto; }
  nav a { display: flex; align-items: center; gap: 10px; padding: 10px 20px; color: var(--text2); text-decoration: none; font-size: 13px; cursor: pointer; transition: all .15s; border-left: 2px solid transparent; }
  nav a:hover, nav a.active { color: var(--text); background: var(--bg3); border-left-color: var(--accent); }
  nav .section-label { padding: 16px 20px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text3); }
  main { overflow-y: auto; padding: 24px; }
  .page { display: none; } .page.active { display: block; }
  h2 { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
  h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--text2); }
  .grid { display: grid; gap: 16px; }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
  .card-sm { padding: 14px 16px; }
  .stat-label { font-size: 12px; color: var(--text3); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .05em; }
  .stat-val { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-sub { font-size: 12px; color: var(--text2); margin-top: 2px; }
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge-green { background: rgba(34,197,94,.15); color: var(--green); }
  .badge-red { background: rgba(239,68,68,.15); color: var(--red); }
  .badge-yellow { background: rgba(245,158,11,.15); color: var(--yellow); }
  .badge-blue { background: rgba(59,130,246,.15); color: var(--blue); }
  .badge-purple { background: rgba(99,102,241,.15); color: var(--accent); }
  input, textarea, select {
    width: 100%; background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 8px 12px; color: var(--text); font-size: 13px; outline: none; font-family: var(--font);
    transition: border-color .15s;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent); }
  textarea { resize: vertical; min-height: 120px; font-family: 'Fira Code', monospace; font-size: 12px; }
  label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 6px; font-weight: 500; }
  .form-group { margin-bottom: 14px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  btn, button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 16px; border-radius: var(--radius); border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; font-family: var(--font); transition: all .15s; white-space: nowrap;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-secondary { background: var(--bg3); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
  .btn-danger { background: rgba(239,68,68,.15); color: var(--red); border: 1px solid rgba(239,68,68,.3); }
  .btn-success { background: rgba(34,197,94,.15); color: var(--green); border: 1px solid rgba(34,197,94,.3); }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn-lg { padding: 12px 24px; font-size: 14px; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .code { font-family: 'Fira Code', monospace; font-size: 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .result-box { margin-top: 16px; }
  .result-box.success .code-header { color: var(--green); }
  .result-box.error .code-header { color: var(--red); }
  .code-header { font-size: 12px; font-weight: 600; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text3); border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text2); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg3); }
  .mono { font-family: 'Fira Code', monospace; font-size: 11px; }
  .truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .events-list { max-height: 500px; overflow-y: auto; }
  .event-item { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; display: flex; gap: 10px; align-items: flex-start; }
  .event-time { color: var(--text3); white-space: nowrap; font-family: monospace; }
  .event-type { font-weight: 600; color: var(--accent); min-width: 200px; }
  .event-payload { color: var(--text2); word-break: break-all; }
  .tabs { display: flex; gap: 2px; margin-bottom: 20px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px; width: fit-content; }
  .tab { padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text2); transition: all .15s; }
  .tab.active { background: var(--accent); color: #fff; }
  .chain-select { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .chain-btn { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg3); color: var(--text2); font-size: 12px; cursor: pointer; transition: all .15s; }
  .chain-btn.active { border-color: var(--accent); color: var(--accent); background: rgba(99,102,241,.1); }
  .gas-card { text-align: center; }
  .gas-val { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 8px 0; }
  .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .wallet-card { display: flex; align-items: center; gap: 16px; }
  .wallet-avatar { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
  .wallet-addr { font-family: monospace; font-size: 12px; color: var(--text2); }
  .wallet-bal { font-size: 18px; font-weight: 700; }
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; background: var(--bg3); border: 1px solid var(--border); border-radius: 999px; cursor: pointer; transition: .2s; }
  .slider:before { content: ''; position: absolute; height: 14px; width: 14px; left: 3px; top: 3px; background: var(--text2); border-radius: 50%; transition: .2s; }
  input:checked + .slider { background: var(--accent); border-color: var(--accent); }
  input:checked + .slider:before { transform: translateX(18px); background: #fff; }
  .flex { display: flex; } .items-center { align-items: center; } .gap-8 { gap: 8px; } .gap-12 { gap: 12px; } .gap-16 { gap: 16px; }
  .ml-auto { margin-left: auto; } .mt-16 { margin-top: 16px; } .mt-8 { margin-top: 8px; }
  .text-sm { font-size: 12px; } .text-green { color: var(--green); } .text-red { color: var(--red); } .text-yellow { color: var(--yellow); }
  .divider { height: 1px; background: var(--border); margin: 16px 0; }
  #toast-container { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 9999; }
  .toast { padding: 12px 16px; border-radius: var(--radius); font-size: 13px; max-width: 320px; animation: slideIn .2s ease; display: flex; align-items: flex-start; gap: 10px; }
  .toast-success { background: rgba(34,197,94,.15); border: 1px solid rgba(34,197,94,.3); color: var(--green); }
  .toast-error { background: rgba(239,68,68,.15); border: 1px solid rgba(239,68,68,.3); color: var(--red); }
  .toast-info { background: rgba(99,102,241,.15); border: 1px solid rgba(99,102,241,.3); color: var(--accent); }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet"/>
</head>
<body>
<div id="app">
  <header>
    <h1>⛓ AI Blockchain Ops</h1>
    <div id="wallet-header" style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2)">
      <span id="wallet-status-text">No wallet</span>
      <button class="btn btn-secondary btn-sm" onclick="connectWallet()">Connect Wallet</button>
    </div>
    <div id="auth-header" style="display:flex;align-items:center;gap:10px;margin-left:auto">
      <span id="auth-status" style="font-size:12px;color:var(--text3)">Not authenticated</span>
      <button class="btn btn-secondary btn-sm" id="auth-btn" onclick="showPage('auth')">Login</button>
    </div>
    <div id="ws-status">
      <div id="ws-dot"></div>
      <span id="ws-label">Disconnected</span>
    </div>
  </header>
  <nav>
    <div class="section-label">Overview</div>
    <a onclick="showPage('dashboard')" data-page="dashboard" class="active">📊 Dashboard</a>
    <a onclick="showPage('gas')" data-page="gas">⛽ Gas Tracker</a>
    <a onclick="showPage('wallet')" data-page="wallet">👛 Wallet</a>
    <div class="section-label">Deploy</div>
    <a onclick="showPage('compile')" data-page="compile">🔨 Compile</a>
    <a onclick="showPage('deploy')" data-page="deploy">🚀 Deploy</a>
    <a onclick="showPage('meme')" data-page="meme">🐸 Meme Token</a>
    <div class="section-label">Operations</div>
    <a onclick="showPage('transactions')" data-page="transactions">📜 Transactions</a>
    <a onclick="showPage('contracts')" data-page="contracts">📋 Contracts</a>
    <a onclick="showPage('ai')" data-page="ai">🤖 AI Assistant</a>
    <div class="section-label">System</div>
    <a onclick="showPage('events')" data-page="events">📡 Live Events</a>
    <a onclick="showPage('auth')" data-page="auth">🔑 Auth</a>
    <a onclick="showPage('settings')" data-page="settings">⚙️ Settings</a>
  </nav>
  <main>

    <!-- DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <h2>Dashboard</h2>
      <div class="grid grid-4" style="margin-bottom:20px">
        <div class="card card-sm">
          <div class="stat-label">Active Chain</div>
          <div class="stat-val" id="dash-chain">—</div>
          <div class="stat-sub" id="dash-chain-id">chainId: —</div>
        </div>
        <div class="card card-sm">
          <div class="stat-label">Gas (gwei)</div>
          <div class="stat-val" id="dash-gas">—</div>
          <div class="stat-sub" id="dash-gas-sub">base fee</div>
        </div>
        <div class="card card-sm">
          <div class="stat-label">Wallet Balance</div>
          <div class="stat-val" id="dash-balance">—</div>
          <div class="stat-sub" id="dash-balance-sub">ETH</div>
        </div>
        <div class="card card-sm">
          <div class="stat-label">Contracts Deployed</div>
          <div class="stat-val" id="dash-contracts">—</div>
          <div class="stat-sub">all chains</div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h3>Recent Transactions</h3>
          <div id="dash-txs"><span class="text-sm" style="color:var(--text3)">No transactions yet</span></div>
        </div>
        <div class="card">
          <h3>Live Events</h3>
          <div id="dash-events" class="events-list" style="max-height:200px"></div>
        </div>
      </div>
    </div>

    <!-- GAS TRACKER -->
    <div class="page" id="page-gas">
      <h2>Gas Tracker</h2>
      <div class="chain-select" id="gas-chain-select"></div>
      <div class="grid grid-3">
        <div class="card gas-card">
          <div class="stat-label">Base Fee</div>
          <div class="gas-val" id="gas-base">—</div>
          <div class="stat-sub">gwei</div>
        </div>
        <div class="card gas-card">
          <div class="stat-label">Max Priority Fee</div>
          <div class="gas-val" id="gas-priority">—</div>
          <div class="stat-sub">gwei</div>
        </div>
        <div class="card gas-card">
          <div class="stat-label">Max Fee</div>
          <div class="gas-val" id="gas-max">—</div>
          <div class="stat-sub">gwei</div>
        </div>
      </div>
      <div class="card mt-16">
        <div class="grid grid-3">
          <div><div class="stat-label">Transfer Cost (21k gas)</div><div id="gas-cost-eth" style="font-weight:600">—</div></div>
          <div><div class="stat-label">Cost (USD est.)</div><div id="gas-cost-usd" style="font-weight:600">—</div></div>
          <div><div class="stat-label">Last Updated</div><div id="gas-updated" style="font-size:12px;color:var(--text2)">—</div></div>
        </div>
        <button class="btn btn-secondary btn-sm mt-16" onclick="fetchGas()">🔄 Refresh</button>
      </div>
    </div>

    <!-- WALLET -->
    <div class="page" id="page-wallet">
      <h2>Wallet</h2>
      <div class="card" style="margin-bottom:16px">
        <h3>Connect / Check Wallet</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Wallet Address</label>
            <input id="wallet-addr-input" placeholder="0x..." />
          </div>
          <div class="form-group">
            <label>Chain</label>
            <select id="wallet-chain-input">
              <option value="1">Ethereum Mainnet</option>
              <option value="8453">Base</option>
              <option value="42161">Arbitrum</option>
              <option value="10">Optimism</option>
              <option value="137">Polygon</option>
              <option value="56">BSC</option>
              <option value="11155111">Sepolia</option>
              <option value="84532">Base Sepolia</option>
              <option value="31337">Localhost</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary" onclick="fetchWalletInfo()">🔍 Fetch Info</button>
        <button class="btn btn-secondary" style="margin-left:8px" onclick="connectWallet()">🦊 Connect MetaMask</button>
      </div>
      <div id="wallet-result" class="card" style="display:none">
        <div class="wallet-card">
          <div class="wallet-avatar">👛</div>
          <div>
            <div class="wallet-bal"><span id="wr-balance">—</span> ETH</div>
            <div class="wallet-addr" id="wr-addr">—</div>
            <div class="flex gap-8 mt-8">
              <span class="badge badge-blue" id="wr-chain">—</span>
              <span class="badge badge-purple">Nonce: <span id="wr-nonce">—</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- COMPILE -->
    <div class="page" id="page-compile">
      <h2>Compile Solidity</h2>
      <div class="grid grid-2" style="align-items:start">
        <div>
          <div class="form-group">
            <label>Contract Name</label>
            <input id="compile-name" value="MyContract" />
          </div>
          <div class="form-group">
            <label>Solidity Version</label>
            <input id="compile-version" value="0.8.24" />
          </div>
          <div class="form-group">
            <div class="flex items-center gap-8" style="margin-bottom:6px">
              <label style="margin:0">Solidity Source</label>
              <button class="btn btn-secondary btn-sm ml-auto" onclick="loadExampleContract()">Load Example</button>
            </div>
            <textarea id="compile-source" style="min-height:360px;font-family:monospace">// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MyContract {
    string public message;
    constructor(string memory _msg) { message = _msg; }
    function setMessage(string memory _msg) external { message = _msg; }
}</textarea>
          </div>
          <button class="btn btn-primary btn-lg" onclick="compileContract()" id="compile-btn">🔨 Compile</button>
        </div>
        <div id="compile-result" class="card" style="display:none">
          <div class="code-header" id="compile-result-header">Result</div>
          <div class="code" id="compile-result-body"></div>
        </div>
      </div>
    </div>

    <!-- DEPLOY -->
    <div class="page" id="page-deploy">
      <h2>Deploy Contract</h2>
      <div class="grid grid-2" style="align-items:start">
        <div>
          <div class="card" style="margin-bottom:16px">
            <h3>Compile First</h3>
            <p style="font-size:12px;color:var(--text2);margin-bottom:12px">Paste your compiled ABI and bytecode, or use the Compile page to generate them.</p>
            <div class="form-group">
              <label>Contract Name</label>
              <input id="deploy-name" placeholder="MyContract" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Chain</label>
                <select id="deploy-chain">
                  <option value="31337">Localhost (anvil)</option>
                  <option value="11155111">Sepolia</option>
                  <option value="84532">Base Sepolia</option>
                  <option value="8453">Base Mainnet</option>
                  <option value="1">Ethereum Mainnet</option>
                  <option value="42161">Arbitrum</option>
                </select>
              </div>
              <div class="form-group">
                <label>From Address</label>
                <input id="deploy-from" placeholder="0x..." />
              </div>
            </div>
            <div class="form-group">
              <label>ABI (JSON)</label>
              <textarea id="deploy-abi" style="min-height:80px" placeholder='[{"type":"constructor","inputs":[]}]'></textarea>
            </div>
            <div class="form-group">
              <label>Bytecode</label>
              <textarea id="deploy-bytecode" style="min-height:60px" placeholder="0x608060..."></textarea>
            </div>
            <div class="form-group">
              <label>Constructor Args (JSON array)</label>
              <input id="deploy-args" placeholder='["Hello World"]' />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>ETH Value (wei)</label>
                <input id="deploy-value" placeholder="0" />
              </div>
              <div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:22px">
                <label class="switch"><input type="checkbox" id="deploy-verify" /><span class="slider"></span></label>
                <span style="font-size:12px">Verify on explorer</span>
              </div>
            </div>
            <div class="form-group" id="verify-key-group" style="display:none">
              <label>Explorer API Key</label>
              <input id="deploy-explorer-key" placeholder="Your Etherscan/Basescan API key" />
            </div>
          </div>
          <button class="btn btn-primary btn-lg" onclick="deployContract()" id="deploy-btn">🚀 Deploy</button>
        </div>
        <div id="deploy-result" class="card" style="display:none">
          <div class="code-header" id="deploy-result-header">Result</div>
          <div class="code" id="deploy-result-body"></div>
        </div>
      </div>
    </div>

    <!-- MEME TOKEN -->
    <div class="page" id="page-meme">
      <h2>🐸 Meme Token Launcher</h2>
      <div class="grid grid-2" style="align-items:start">
        <div>
          <div class="card" style="margin-bottom:16px">
            <h3>Token Config</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Token Name</label>
                <input id="meme-name" placeholder="Pepe Coin" />
              </div>
              <div class="form-group">
                <label>Symbol</label>
                <input id="meme-symbol" placeholder="PEPE" maxlength="10" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Total Supply</label>
                <input id="meme-supply" placeholder="1000000000" value="1000000000" />
              </div>
              <div class="form-group">
                <label>Decimals</label>
                <input id="meme-decimals" type="number" value="18" min="0" max="18" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group" style="display:flex;align-items:center;gap:8px">
                <label class="switch"><input type="checkbox" id="meme-mintable" /><span class="slider"></span></label>
                <span style="font-size:12px">Mintable</span>
              </div>
              <div class="form-group" style="display:flex;align-items:center;gap:8px">
                <label class="switch"><input type="checkbox" id="meme-burnable" checked /><span class="slider"></span></label>
                <span style="font-size:12px">Burnable</span>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <h3>Tax Config</h3>
            <div class="form-row-3">
              <div class="form-group">
                <label>Buy Tax %</label>
                <input id="meme-buy-tax" type="number" value="0" min="0" max="25" />
              </div>
              <div class="form-group">
                <label>Sell Tax %</label>
                <input id="meme-sell-tax" type="number" value="0" min="0" max="25" />
              </div>
              <div class="form-group">
                <label>Tax Wallet</label>
                <input id="meme-tax-wallet" placeholder="0x... (default: deployer)" />
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <h3>Limits</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Max Wallet %</label>
                <input id="meme-max-wallet" type="number" value="2" min="0" max="100" />
              </div>
              <div class="form-group">
                <label>Max Tx %</label>
                <input id="meme-max-tx" type="number" value="1" min="0" max="100" />
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <h3>Deployment</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Chain</label>
                <select id="meme-chain">
                  <option value="31337">Localhost</option>
                  <option value="11155111">Sepolia</option>
                  <option value="84532">Base Sepolia</option>
                  <option value="8453">Base Mainnet</option>
                  <option value="1">Ethereum Mainnet</option>
                  <option value="42161">Arbitrum</option>
                </select>
              </div>
              <div class="form-group">
                <label>From Address</label>
                <input id="meme-from" placeholder="0x..." />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group" style="display:flex;align-items:center;gap:8px">
                <label class="switch"><input type="checkbox" id="meme-verify" /><span class="slider"></span></label>
                <span style="font-size:12px">Verify on explorer</span>
              </div>
              <div class="form-group" style="display:flex;align-items:center;gap:8px">
                <label class="switch"><input type="checkbox" id="meme-deploy-only" checked /><span class="slider"></span></label>
                <span style="font-size:12px">Deploy only (no LP)</span>
              </div>
            </div>
          </div>
          <div class="flex gap-8">
            <button class="btn btn-secondary" onclick="previewMemeSource()">👁 Preview Source</button>
            <button class="btn btn-primary btn-lg" onclick="launchMemeToken()" id="meme-btn">🚀 Launch Token</button>
          </div>
        </div>
        <div>
          <div id="meme-result" class="card" style="display:none">
            <div class="code-header" id="meme-result-header">Launch Result</div>
            <div class="code" id="meme-result-body"></div>
          </div>
          <div id="meme-source-preview" class="card mt-16" style="display:none">
            <div class="code-header">Generated Solidity</div>
            <div class="code" id="meme-source-body"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- TRANSACTIONS -->
    <div class="page" id="page-transactions">
      <h2>Transactions</h2>
      <div class="card" style="margin-bottom:16px">
        <h3>Send Transaction</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Chain</label>
            <select id="tx-chain">
              <option value="31337">Localhost</option>
              <option value="11155111">Sepolia</option>
              <option value="1">Ethereum</option>
              <option value="8453">Base</option>
            </select>
          </div>
          <div class="form-group">
            <label>From</label>
            <input id="tx-from" placeholder="0x..." />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>To</label>
            <input id="tx-to" placeholder="0x..." />
          </div>
          <div class="form-group">
            <label>Value (wei)</label>
            <input id="tx-value" placeholder="0" />
          </div>
        </div>
        <div class="form-group">
          <label>Data (hex calldata, optional)</label>
          <input id="tx-data" placeholder="0x" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <input id="tx-desc" placeholder="Transfer ETH" />
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary" onclick="simulateTx()">🔍 Simulate</button>
          <button class="btn btn-primary" onclick="sendTx()" id="tx-btn">📤 Send</button>
        </div>
      </div>
      <div id="tx-result" class="card" style="display:none">
        <div class="code-header" id="tx-result-header">Result</div>
        <div class="code" id="tx-result-body"></div>
      </div>
      <div class="card mt-16">
        <h3>Transaction History</h3>
        <button class="btn btn-secondary btn-sm" onclick="loadTransactions()" style="margin-bottom:12px">🔄 Refresh</button>
        <div id="tx-history"><span style="font-size:12px;color:var(--text3)">Loading...</span></div>
      </div>
    </div>

    <!-- CONTRACTS -->
    <div class="page" id="page-contracts">
      <h2>Deployed Contracts</h2>
      <button class="btn btn-secondary btn-sm" onclick="loadContracts()" style="margin-bottom:16px">🔄 Refresh</button>
      <div id="contracts-list" class="card">
        <span style="font-size:12px;color:var(--text3)">Loading...</span>
      </div>
    </div>

    <!-- AI ASSISTANT -->
    <div class="page" id="page-ai">
      <h2>🤖 AI Assistant</h2>
      <div class="card" style="margin-bottom:16px">
        <div class="form-group">
          <label>Instruction</label>
          <textarea id="ai-instruction" style="min-height:100px" placeholder="Write a Solidity ERC20 token with burn functionality...&#10;Audit this contract for security issues...&#10;Explain how to add liquidity to Uniswap V3..."></textarea>
        </div>
        <div class="form-row">
          <div class="form-group" style="display:flex;align-items:center;gap:8px">
            <label class="switch"><input type="checkbox" id="ai-audit" checked /><span class="slider"></span></label>
            <span style="font-size:12px">Require audit</span>
          </div>
          <div class="form-group" style="display:flex;align-items:center;gap:8px">
            <label class="switch"><input type="checkbox" id="ai-mcp" /><span class="slider"></span></label>
            <span style="font-size:12px">Use MCP tools</span>
          </div>
        </div>
        <button class="btn btn-primary btn-lg" onclick="runAI()" id="ai-btn">🤖 Run AI</button>
      </div>
      <div id="ai-result" class="card" style="display:none">
        <div class="code-header" id="ai-result-header">AI Output</div>
        <div id="ai-result-body" style="white-space:pre-wrap;font-size:13px;line-height:1.6"></div>
      </div>
    </div>

    <!-- LIVE EVENTS -->
    <div class="page" id="page-events">
      <h2>Live Events</h2>
      <div class="flex gap-8" style="margin-bottom:16px">
        <button class="btn btn-success btn-sm" onclick="clearEvents()">🗑 Clear</button>
        <span id="events-count" style="font-size:12px;color:var(--text2);align-self:center">0 events</span>
      </div>
      <div class="card">
        <div class="events-list" id="events-list"></div>
      </div>
    </div>

    <!-- AUTH -->
    <div class="page" id="page-auth">
      <h2>Authentication</h2>
      <div class="grid grid-2">
        <div>
          <div class="tabs">
            <div class="tab active" onclick="switchAuthTab('login')">Login</div>
            <div class="tab" onclick="switchAuthTab('register')">Register</div>
            <div class="tab" onclick="switchAuthTab('client')">OAuth Client</div>
          </div>
          <div id="auth-login" class="card">
            <div class="form-group"><label>Email</label><input id="login-email" type="email" placeholder="admin@example.com" /></div>
            <div class="form-group"><label>Password</label><input id="login-pass" type="password" /></div>
            <button class="btn btn-primary" onclick="login()" id="login-btn">🔑 Login</button>
          </div>
          <div id="auth-register" class="card" style="display:none">
            <div class="form-group"><label>Email</label><input id="reg-email" type="email" /></div>
            <div class="form-group"><label>Password (min 12 chars)</label><input id="reg-pass" type="password" /></div>
            <div class="form-group"><label>Role</label>
              <select id="reg-role"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select>
            </div>
            <button class="btn btn-primary" onclick="register()" id="reg-btn">📝 Register</button>
          </div>
          <div id="auth-client" class="card" style="display:none">
            <div class="form-group"><label>Client Name</label><input id="client-name" placeholder="my-app" /></div>
            <div class="form-group"><label>Scopes (space separated)</label><input id="client-scopes" value="tasks:read tasks:write blockchain:read blockchain:write blockchain:deploy" /></div>
            <button class="btn btn-primary" onclick="createClient()" id="client-btn">➕ Create Client</button>
          </div>
        </div>
        <div class="card" id="auth-result-card" style="display:none">
          <div class="code-header" id="auth-result-header">Result</div>
          <div class="code" id="auth-result-body"></div>
        </div>
      </div>
    </div>

    <!-- SETTINGS -->
    <div class="page" id="page-settings">
      <h2>Settings</h2>
      <div class="grid grid-2">
        <div class="card">
          <h3>RPC URLs</h3>
          <p style="font-size:12px;color:var(--text2);margin-bottom:12px">Configure custom RPC endpoints. These are stored locally in your browser.</p>
          <div class="form-group"><label>Ethereum</label><input id="rpc-eth" placeholder="https://eth.llamarpc.com" /></div>
          <div class="form-group"><label>Base</label><input id="rpc-base" placeholder="https://mainnet.base.org" /></div>
          <div class="form-group"><label>Arbitrum</label><input id="rpc-arb" placeholder="https://arb1.arbitrum.io/rpc" /></div>
          <div class="form-group"><label>Localhost</label><input id="rpc-local" placeholder="http://127.0.0.1:8545" value="http://127.0.0.1:8545" /></div>
          <button class="btn btn-primary" onclick="saveSettings()">💾 Save</button>
        </div>
        <div class="card">
          <h3>System Status</h3>
          <div id="system-status"><span style="font-size:12px;color:var(--text3)">Loading...</span></div>
          <button class="btn btn-secondary btn-sm mt-16" onclick="loadStatus()">🔄 Refresh</button>
        </div>
      </div>
    </div>

  </main>
</div>
<div id="toast-container"></div>

<script>
// ── State ─────────────────────────────────────────────────────
let authToken = localStorage.getItem('authToken') ?? '';
let connectedWallet = '';
let ws = null;
let allEvents = [];

// ── Utils ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const val = id => $(id)?.value ?? '';
const checked = id => $(id)?.checked ?? false;

function toast(msg, type = 'info') {
  const c = $('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setLoading(btnId, loading) {
  const btn = $(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.dataset.orig = btn.innerHTML, btn.innerHTML = '<span class="loading"></span> Working...';
  else btn.innerHTML = btn.dataset.orig ?? btn.innerHTML;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch('/api' + path, { headers, ...options });
  return res;
}

// ── Navigation ────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name)?.classList.add('active');
  document.querySelector('[data-page="' + name + '"]')?.classList.add('active');
  if (name === 'gas') fetchGas();
  if (name === 'contracts') loadContracts();
  if (name === 'transactions') loadTransactions();
  if (name === 'settings') loadStatus();
}

// ── WebSocket ─────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = () => {
    $('ws-dot').classList.add('connected');
    $('ws-label').textContent = 'Connected';
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'event') handleEvent(msg.data);
    } catch {}
  };
  ws.onclose = () => {
    $('ws-dot').classList.remove('connected');
    $('ws-label').textContent = 'Disconnected';
    setTimeout(connectWS, 3000);
  };
}

function handleEvent(event) {
  allEvents.unshift(event);
  if (allEvents.length > 200) allEvents.pop();

  // Update live events page
  const list = $('events-list');
  const item = document.createElement('div');
  item.className = 'event-item';
  item.innerHTML = '<span class="event-time">' + new Date(event.emittedAt).toLocaleTimeString() + '</span>'
    + '<span class="event-type">' + event.type + '</span>'
    + '<span class="event-payload">' + JSON.stringify(event.payload).slice(0, 120) + '</span>';
  list.prepend(item);
  $('events-count').textContent = allEvents.length + ' events';

  // Update dashboard events
  const dashEvents = $('dash-events');
  const di = document.createElement('div');
  di.className = 'event-item';
  di.style.fontSize = '11px';
  di.innerHTML = '<span style="color:var(--text3)">' + new Date(event.emittedAt).toLocaleTimeString() + '</span>'
    + ' <span style="color:var(--accent)">' + event.type + '</span>';
  dashEvents.prepend(di);
  if (dashEvents.children.length > 10) dashEvents.lastChild?.remove();

  // Toast for important events
  if (event.type === 'blockchain.tx_confirmed') toast('✅ TX confirmed: ' + (event.payload?.txHash?.toString().slice(0, 10) ?? ''), 'success');
  if (event.type === 'blockchain.tx_failed') toast('❌ TX failed', 'error');
  if (event.type === 'blockchain.contract_deployed') toast('🚀 Contract deployed: ' + (event.payload?.contractAddress?.toString().slice(0, 12) ?? ''), 'success');
}

function clearEvents() { allEvents = []; $('events-list').innerHTML = ''; $('events-count').textContent = '0 events'; }

// ── Gas ───────────────────────────────────────────────────────
const GAS_CHAINS = [1, 8453, 42161, 10, 137, 31337];
let gasChainId = 1;

function buildGasChainSelect() {
  const names = {1:'ETH',8453:'Base',42161:'Arb',10:'OP',137:'MATIC',31337:'Local'};
  const c = $('gas-chain-select');
  GAS_CHAINS.forEach(id => {
    const btn = document.createElement('button');
    btn.className = 'chain-btn' + (id === gasChainId ? ' active' : '');
    btn.textContent = names[id] ?? id;
    btn.onclick = () => { gasChainId = id; document.querySelectorAll('.chain-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); fetchGas(); };
    c.appendChild(btn);
  });
}

async function fetchGas() {
  try {
    const res = await api('/blockchain/gas?chainId=' + gasChainId);
    if (!res.ok) throw new Error(await res.text());
    const g = await res.json();
    $('gas-base').textContent = parseFloat(g.baseFeeGwei).toFixed(2);
    $('gas-priority').textContent = parseFloat(g.maxPriorityFeeGwei).toFixed(2);
    $('gas-max').textContent = parseFloat(g.maxFeeGwei).toFixed(2);
    $('gas-cost-eth').textContent = g.estimatedCostEth + ' ETH';
    $('gas-cost-usd').textContent = g.estimatedCostUsd ? '$' + g.estimatedCostUsd : 'N/A';
    $('gas-updated').textContent = new Date(g.fetchedAt).toLocaleTimeString();
    $('dash-gas').textContent = parseFloat(g.baseFeeGwei).toFixed(1);
  } catch (e) { toast('Gas fetch failed: ' + e.message, 'error'); }
}

// ── Wallet ────────────────────────────────────────────────────
async function connectWallet() {
  if (!window.ethereum) { toast('MetaMask not detected', 'error'); return; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
    connectedWallet = accounts[0];
    const chainId = parseInt(chainIdHex, 16);
    $('wallet-status-text').textContent = connectedWallet.slice(0, 6) + '...' + connectedWallet.slice(-4);
    $('wallet-addr-input').value = connectedWallet;
    $('deploy-from').value = connectedWallet;
    $('meme-from').value = connectedWallet;
    $('tx-from').value = connectedWallet;
    toast('Wallet connected: ' + connectedWallet.slice(0, 10) + '...', 'success');
    await fetchWalletInfo();
  } catch (e) { toast('Wallet connection failed: ' + e.message, 'error'); }
}

async function fetchWalletInfo() {
  const addr = val('wallet-addr-input');
  const chainId = val('wallet-chain-input');
  if (!addr || !addr.startsWith('0x')) { toast('Enter a valid address', 'error'); return; }
  try {
    const res = await api('/blockchain/wallet?address=' + addr + '&chainId=' + chainId);
    if (!res.ok) throw new Error(await res.text());
    const w = await res.json();
    $('wallet-result').style.display = 'block';
    $('wr-balance').textContent = parseFloat(w.balanceEth).toFixed(6);
    $('wr-addr').textContent = w.address;
    $('wr-chain').textContent = 'chainId: ' + w.chainId;
    $('wr-nonce').textContent = w.nonce;
    $('dash-balance').textContent = parseFloat(w.balanceEth).toFixed(4);
    $('dash-chain').textContent = w.chainId;
    $('dash-chain-id').textContent = 'chainId: ' + w.chainId;
  } catch (e) { toast('Wallet fetch failed: ' + e.message, 'error'); }
}

// ── Compile ───────────────────────────────────────────────────
function loadExampleContract() {
  $('compile-source').value = \`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ExampleToken is ERC20, Ownable {
    constructor() ERC20("Example", "EXM") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 * 10**18);
    }
}\`;
  $('compile-name').value = 'ExampleToken';
}

async function compileContract() {
  setLoading('compile-btn', true);
  try {
    const res = await api('/blockchain/compile', {
      method: 'POST',
      body: JSON.stringify({
        taskId: crypto.randomUUID(),
        contractName: val('compile-name'),
        source: val('compile-source'),
        solidityVersion: val('compile-version') || '0.8.24',
      }),
    });
    const data = await res.json();
    $('compile-result').style.display = 'block';
    $('compile-result-header').textContent = data.success ? '✅ Compiled Successfully' : '❌ Compilation Failed';
    $('compile-result-header').style.color = data.success ? 'var(--green)' : 'var(--red)';
    if (data.success) {
      $('compile-result-body').textContent = JSON.stringify({ abi: data.abi?.slice(0, 3), bytecode: data.bytecode?.slice(0, 60) + '...', warnings: data.warnings }, null, 2);
      // Pre-fill deploy
      $('deploy-abi').value = JSON.stringify(data.abi);
      $('deploy-bytecode').value = data.bytecode;
      $('deploy-name').value = val('compile-name');
      toast('Compiled! ABI/bytecode pre-filled in Deploy tab', 'success');
    } else {
      $('compile-result-body').textContent = (data.errors ?? []).join('\\n');
    }
  } catch (e) { toast('Compile error: ' + e.message, 'error'); }
  setLoading('compile-btn', false);
}

// ── Deploy ────────────────────────────────────────────────────
$('deploy-verify')?.addEventListener('change', () => {
  $('verify-key-group').style.display = $('deploy-verify').checked ? 'block' : 'none';
});

async function deployContract() {
  setLoading('deploy-btn', true);
  try {
    let abi;
    try { abi = JSON.parse(val('deploy-abi')); } catch { toast('Invalid ABI JSON', 'error'); setLoading('deploy-btn', false); return; }
    const bytecode = val('deploy-bytecode');
    if (!bytecode.startsWith('0x')) { toast('Bytecode must start with 0x', 'error'); setLoading('deploy-btn', false); return; }
    let args;
    const argsStr = val('deploy-args').trim();
    if (argsStr) { try { args = JSON.parse(argsStr); } catch { toast('Invalid constructor args JSON', 'error'); setLoading('deploy-btn', false); return; } }

    const res = await api('/blockchain/deploy', {
      method: 'POST',
      body: JSON.stringify({
        taskId: crypto.randomUUID(),
        chainId: parseInt(val('deploy-chain')),
        from: val('deploy-from'),
        contractName: val('deploy-name'),
        abi, bytecode,
        constructorArgs: args,
        value: val('deploy-value') || undefined,
        verify: checked('deploy-verify'),
        explorerApiKey: val('deploy-explorer-key') || undefined,
      }),
    });
    const data = await res.json();
    $('deploy-result').style.display = 'block';
    $('deploy-result-header').textContent = data.success ? '✅ Deployed!' : '❌ Deploy Failed';
    $('deploy-result-header').style.color = data.success ? 'var(--green)' : 'var(--red)';
    $('deploy-result-body').textContent = JSON.stringify(data, null, 2);
    if (data.success) toast('Contract deployed: ' + data.contractAddress, 'success');
    else toast('Deploy failed: ' + (data.error ?? ''), 'error');
  } catch (e) { toast('Deploy error: ' + e.message, 'error'); }
  setLoading('deploy-btn', false);
}

// ── Meme Token ────────────────────────────────────────────────
function getMemeConfig() {
  return {
    name: val('meme-name'),
    symbol: val('meme-symbol'),
    totalSupply: val('meme-supply'),
    decimals: parseInt(val('meme-decimals') || '18'),
    mintable: checked('meme-mintable'),
    burnable: checked('meme-burnable'),
    taxBuyPercent: parseFloat(val('meme-buy-tax') || '0'),
    taxSellPercent: parseFloat(val('meme-sell-tax') || '0'),
    taxWallet: val('meme-tax-wallet') || undefined,
    maxWalletPercent: parseFloat(val('meme-max-wallet') || '0') || undefined,
    maxTxPercent: parseFloat(val('meme-max-tx') || '0') || undefined,
  };
}

async function previewMemeSource() {
  try {
    const res = await api('/blockchain/meme-token/generate-source', {
      method: 'POST',
      body: JSON.stringify({ config: getMemeConfig() }),
    });
    const data = await res.json();
    $('meme-source-preview').style.display = 'block';
    $('meme-source-body').textContent = data.source;
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function launchMemeToken() {
  if (!val('meme-name') || !val('meme-symbol')) { toast('Name and symbol required', 'error'); return; }
  if (!val('meme-from')) { toast('Deployer address required', 'error'); return; }
  setLoading('meme-btn', true);
  try {
    const res = await api('/blockchain/meme-token', {
      method: 'POST',
      body: JSON.stringify({
        taskId: crypto.randomUUID(),
        chainId: parseInt(val('meme-chain')),
        from: val('meme-from'),
        config: getMemeConfig(),
        verify: checked('meme-verify'),
        deployOnly: checked('meme-deploy-only'),
      }),
    });
    const data = await res.json();
    $('meme-result').style.display = 'block';
    const ok = data.token?.address;
    $('meme-result-header').textContent = ok ? '🐸 Token Launched!' : '❌ Launch Failed';
    $('meme-result-header').style.color = ok ? 'var(--green)' : 'var(--red)';
    $('meme-result-body').textContent = JSON.stringify(data, null, 2);
    if (ok) toast('Token launched: ' + data.token.address, 'success');
    else toast('Launch failed: ' + (data.error ?? ''), 'error');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading('meme-btn', false);
}

// ── Transactions ──────────────────────────────────────────────
async function simulateTx() {
  const payload = { taskId: crypto.randomUUID(), chainId: parseInt(val('tx-chain')), from: val('tx-from'), to: val('tx-to') || undefined, value: val('tx-value') || undefined, data: val('tx-data') || undefined, description: val('tx-desc') || 'Simulation' };
  setLoading('tx-btn', true);
  try {
    const res = await api('/blockchain/simulate', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    $('tx-result').style.display = 'block';
    $('tx-result-header').textContent = data.success ? '✅ Simulation Passed' : '❌ Simulation Failed';
    $('tx-result-header').style.color = data.success ? 'var(--green)' : 'var(--red)';
    $('tx-result-body').textContent = JSON.stringify(data, null, 2);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading('tx-btn', false);
}

async function sendTx() {
  if (!confirm('Are you sure you want to send this transaction? This will use real funds on mainnet.')) return;
  setLoading('tx-btn', true);
  try {
    const res = await api('/blockchain/transaction', {
      method: 'POST',
      body: JSON.stringify({ taskId: crypto.randomUUID(), chainId: parseInt(val('tx-chain')), from: val('tx-from'), to: val('tx-to'), value: val('tx-value') || undefined, data: val('tx-data') || undefined, description: val('tx-desc') || 'Transaction', simulate: true }),
    });
    const data = await res.json();
    $('tx-result').style.display = 'block';
    $('tx-result-header').textContent = data.status === 'confirmed' ? '✅ Confirmed' : data.status === 'submitted' ? '📤 Submitted' : '❌ Failed';
    $('tx-result-body').textContent = JSON.stringify(data, null, 2);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading('tx-btn', false);
}

async function loadTransactions() {
  try {
    const res = await api('/blockchain/transactions?limit=20');
    const data = await res.json();
    const txs = data.transactions ?? data ?? [];
    const el = $('tx-history');
    if (!txs.length) { el.innerHTML = '<span style="font-size:12px;color:var(--text3)">No transactions</span>'; return; }
    el.innerHTML = '<table><thead><tr><th>Hash</th><th>Status</th><th>Chain</th><th>Description</th><th>Time</th></tr></thead><tbody>'
      + txs.map(t => \`<tr><td class="mono truncate">\${t.tx_hash ?? t.txHash ?? '—'}</td><td>\${t.status}</td><td>\${t.chain_id ?? t.chainId}</td><td class="truncate">\${t.description ?? ''}</td><td>\${t.submitted_at ? new Date(t.submitted_at).toLocaleTimeString() : ''}</td></tr>\`).join('')
      + '</tbody></table>';
    const dashTxs = $('dash-txs');
    dashTxs.innerHTML = txs.slice(0,5).map(t => \`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2)">\${t.status === 'confirmed' ? '✅' : '❌'} \${(t.tx_hash ?? t.txHash ?? '—').slice(0,12)}... <span style="color:var(--text3)">\${t.description ?? ''}</span></div>\`).join('');
    $('dash-contracts').textContent = txs.filter(t => t.description?.includes('deploy')).length;
  } catch (e) {}
}

async function loadContracts() {
  try {
    const res = await api('/blockchain/contracts?limit=50');
    const data = await res.json();
    const contracts = data.contracts ?? data ?? [];
    const el = $('contracts-list');
    if (!contracts.length) { el.innerHTML = '<span style="font-size:12px;color:var(--text3)">No contracts deployed yet</span>'; return; }
    el.innerHTML = '<table><thead><tr><th>Name</th><th>Address</th><th>Chain</th><th>Verified</th><th>Deployed</th></tr></thead><tbody>'
      + contracts.map(c => \`<tr><td>\${c.name}</td><td class="mono truncate">\${c.address}</td><td>\${c.chain_id ?? c.chainId}</td><td>\${c.verified ? '✅' : '—'}</td><td>\${c.deployed_at ? new Date(c.deployed_at).toLocaleDateString() : ''}</td></tr>\`).join('')
      + '</tbody></table>';
  } catch (e) {}
}

// ── AI Assistant ──────────────────────────────────────────────
async function runAI() {
  if (!authToken) { toast('Login required for AI assistant', 'error'); return; }
  const instruction = val('ai-instruction');
  if (!instruction.trim()) { toast('Enter an instruction', 'error'); return; }
  setLoading('ai-btn', true);
  try {
    const res = await api('/run', {
      method: 'POST',
      body: JSON.stringify({ instruction, requiresAudit: checked('ai-audit'), useMcp: checked('ai-mcp'), priority: 'high' }),
    });
    const data = await res.json();
    $('ai-result').style.display = 'block';
    $('ai-result-header').textContent = data.status === 'completed' ? '✅ ' + data.status : '⚠️ ' + data.status;
    $('ai-result-header').style.color = data.status === 'completed' ? 'var(--green)' : 'var(--yellow)';
    $('ai-result-body').textContent = data.output ?? JSON.stringify(data, null, 2);
  } catch (e) { toast('AI error: ' + e.message, 'error'); }
  setLoading('ai-btn', false);
}

// ── Auth ──────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('#page-auth .tab').forEach((t, i) => t.classList.toggle('active', ['login','register','client'][i] === tab));
  $('auth-login').style.display = tab === 'login' ? '' : 'none';
  $('auth-register').style.display = tab === 'register' ? '' : 'none';
  $('auth-client').style.display = tab === 'client' ? '' : 'none';
}

async function login() {
  setLoading('login-btn', true);
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email: val('login-email'), password: val('login-pass') }) });
    const data = await res.json();
    if (data.access_token) {
      authToken = data.access_token;
      localStorage.setItem('authToken', authToken);
      $('auth-status').textContent = 'Logged in';
      $('auth-btn').textContent = 'Logout';
      $('auth-btn').onclick = logout;
      $('auth-result-card').style.display = 'block';
      $('auth-result-header').textContent = '✅ Login successful';
      $('auth-result-body').textContent = JSON.stringify({ scope: data.scope, expires_in: data.expires_in }, null, 2);
      toast('Logged in!', 'success');
    } else { $('auth-result-card').style.display = 'block'; $('auth-result-header').textContent = '❌ Login failed'; $('auth-result-body').textContent = JSON.stringify(data, null, 2); }
  } catch (e) { toast('Login error: ' + e.message, 'error'); }
  setLoading('login-btn', false);
}

async function register() {
  setLoading('reg-btn', true);
  try {
    const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email: val('reg-email'), password: val('reg-pass'), role: val('reg-role') }) });
    const data = await res.json();
    $('auth-result-card').style.display = 'block';
    $('auth-result-header').textContent = res.ok ? '✅ Registered' : '❌ Failed';
    $('auth-result-body').textContent = JSON.stringify(data, null, 2);
    if (res.ok) toast('Registered! You can now login.', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading('reg-btn', false);
}

async function createClient() {
  setLoading('client-btn', true);
  try {
    const res = await api('/auth/token', { method: 'POST', body: JSON.stringify({ grant_type: 'client_credentials' }) });
    const data = await res.json();
    $('auth-result-card').style.display = 'block';
    $('auth-result-body').textContent = JSON.stringify(data, null, 2);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading('client-btn', false);
}

function logout() {
  authToken = '';
  localStorage.removeItem('authToken');
  $('auth-status').textContent = 'Not authenticated';
  $('auth-btn').textContent = 'Login';
  $('auth-btn').onclick = () => showPage('auth');
  toast('Logged out', 'info');
}

// ── Settings / Status ─────────────────────────────────────────
function saveSettings() {
  localStorage.setItem('rpc-eth', val('rpc-eth'));
  localStorage.setItem('rpc-base', val('rpc-base'));
  localStorage.setItem('rpc-arb', val('rpc-arb'));
  localStorage.setItem('rpc-local', val('rpc-local'));
  toast('Settings saved locally', 'success');
}

async function loadStatus() {
  const el = $('system-status');
  el.innerHTML = '<span class="loading"></span>';
  try {
    const res = await api('/status');
    const data = await res.json();
    const modules = data.modules ?? {};
    el.innerHTML = Object.entries(modules).map(([k, v]) =>
      \`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px"><span style="color:var(--text2)">\${k}</span><span class="\${v === 'online' ? 'badge badge-green' : 'badge badge-red'}">\${v}</span></div>\`
    ).join('');
  } catch { el.innerHTML = '<span style="font-size:12px;color:var(--text3)">Status unavailable (login required)</span>'; }
}

// ── Init ──────────────────────────────────────────────────────
buildGasChainSelect();
connectWS();

if (authToken) {
  $('auth-status').textContent = 'Authenticated';
  $('auth-btn').textContent = 'Logout';
  $('auth-btn').onclick = logout;
}

// Load initial data
setTimeout(fetchGas, 500);
setTimeout(loadTransactions, 1000);

// Auto-refresh gas every 30s
setInterval(fetchGas, 30_000);
</script>
</body>
</html>`;

  await writeFile(join(PUBLIC_DIR, 'index.html'), html, 'utf-8');
  fastify.log.info(`Frontend built → ${PUBLIC_DIR}/index.html`);
}

// ── Start ─────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  for (const client of wsClients) client.terminate();
  await fastify.close(); process.exit(0);
});
process.on('SIGINT', async () => {
  for (const client of wsClients) client.terminate();
  await fastify.close(); process.exit(0);
});

const start = async () => {
  try {
    await buildFrontend();

    const server = createServer(fastify.server);
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit('connection', ws, req));
      } else {
        socket.destroy();
      }
    });

    await fastify.listen({ port: 3012, host: '0.0.0.0' });

    // Override the listening server with our WS-capable one
    fastify.log.info('🖥️  Frontend Server online — http://localhost:3012');
    fastify.log.info(`📅 ${getTodayDate()} | WebSocket: ws://localhost:3012/ws`);

    void startEventRelay();
  } catch (err) { fastify.log.error(err, 'Frontend Server failed'); process.exit(1); }
};
start();
