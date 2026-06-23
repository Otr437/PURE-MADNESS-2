"""
AdminServer — web-based admin panel.

Routes:
  GET  /          — dashboard HTML
  GET  /api/stats — JSON stats
  GET  /api/config — JSON config dump
  POST /api/evaluate — inline eval
  POST /api/predict  — inline predict
  POST /api/analyze  — inline analyze
  POST /api/config/update — update config keys
"""

import http.server
import json
import threading
from typing import Any


def _send_json(req, data: Any, status: int = 200) -> None:
    payload = json.dumps(data, default=str, indent=2).encode()
    req.send_response(status)
    req.send_header("Content-Type",  "application/json")
    req.send_header("Content-Length", str(len(payload)))
    req.send_header("Access-Control-Allow-Origin", "*")
    req.end_headers()
    req.wfile.write(payload)


def _read_body(req) -> dict:
    length = int(req.headers.get("Content-Length", 0))
    raw    = req.rfile.read(length) if length else b"{}"
    try:    return json.loads(raw)
    except: return {}


_ADMIN_HTML = r"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Math Engine — Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#eee;min-height:100vh}
.header{background:#16213e;padding:18px 30px;border-bottom:2px solid #e94560;display:flex;align-items:center;gap:14px}
.header h1{color:#e94560;font-size:1.5rem}
.container{display:flex;height:calc(100vh - 60px)}
.sidebar{width:220px;background:#16213e;padding:15px;flex-shrink:0;border-right:1px solid #0f3460}
.sidebar button{display:block;width:100%;padding:10px 12px;margin:4px 0;background:#0f3460;color:#ccc;border:none;border-radius:6px;cursor:pointer;text-align:left;font-size:0.9rem;transition:background .2s}
.sidebar button:hover,.sidebar button.active{background:#e94560;color:#fff}
.main{flex:1;padding:20px;overflow-y:auto}
.card{background:#16213e;border-radius:10px;padding:20px;margin-bottom:18px;border:1px solid #0f3460}
.card h3{color:#e94560;margin-bottom:14px;font-size:1rem}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat-box{background:#0f3460;padding:14px;border-radius:8px;text-align:center}
.stat-val{font-size:2rem;font-weight:700;color:#e94560}
.stat-lbl{font-size:0.75rem;text-transform:uppercase;color:#aaa;margin-top:4px}
input,textarea,select{width:100%;padding:9px 11px;margin:5px 0 12px;background:#0f3460;border:1px solid #1a1a2e;color:#eee;border-radius:6px;font-size:0.9rem}
button.btn{background:#e94560;color:#fff;border:none;padding:9px 18px;border-radius:6px;cursor:pointer;font-size:0.9rem}
button.btn:hover{background:#ff6b6b}
pre{background:#0f3460;padding:14px;border-radius:6px;overflow:auto;font-size:0.82rem;max-height:360px;color:#7ec8e3}
.tab{display:none}.tab.active{display:block}
label{font-size:0.82rem;color:#aaa;display:block}
</style>
</head>
<body>
<div class="header"><span style="font-size:1.6rem">🔢</span><h1>Math Engine — Admin Panel</h1></div>
<div class="container">
<div class="sidebar">
  <button class="active" onclick="show('dashboard',this)">📊 Dashboard</button>
  <button onclick="show('evaluate',this)">🧮 Evaluate</button>
  <button onclick="show('predict',this)">📈 Predict</button>
  <button onclick="show('analyze',this)">📉 Analyze</button>
  <button onclick="show('random',this)">🎲 Random Math</button>
  <button onclick="show('config',this)">⚙️ Config</button>
  <button onclick="show('history',this)">📜 History</button>
  <button onclick="refreshStats()" style="margin-top:20px">🔄 Refresh</button>
</div>
<div class="main">

<div id="dashboard" class="tab active">
  <div class="card">
    <h3>System Statistics</h3>
    <div class="stats-grid">
      <div class="stat-box"><div class="stat-val" id="s-eq">—</div><div class="stat-lbl">Equations</div></div>
      <div class="stat-box"><div class="stat-val" id="s-res">—</div><div class="stat-lbl">Results</div></div>
      <div class="stat-box"><div class="stat-val" id="s-pred">—</div><div class="stat-lbl">Predictions</div></div>
      <div class="stat-box"><div class="stat-val" id="s-thm">—</div><div class="stat-lbl">Theorems</div></div>
      <div class="stat-box"><div class="stat-val" id="s-db">—</div><div class="stat-lbl">DB (MB)</div></div>
      <div class="stat-box"><div class="stat-val" id="s-mem">—</div><div class="stat-lbl">Mem (MB)</div></div>
    </div>
  </div>
</div>

<div id="evaluate" class="tab">
  <div class="card">
    <h3>Evaluate Expression</h3>
    <label>Expression</label>
    <input id="ev-expr" placeholder="e.g. sqrt(16) + sin(pi/2)">
    <button class="btn" onclick="doEval()">Evaluate</button>
    <pre id="ev-out">—</pre>
  </div>
</div>

<div id="predict" class="tab">
  <div class="card">
    <h3>Time-Series Prediction</h3>
    <label>History data (comma-separated)</label>
    <textarea id="pr-data" rows="3" placeholder="1,2,3,4,5,6,7,8,9,10"></textarea>
    <label>Steps ahead</label>
    <input id="pr-steps" type="number" value="5">
    <button class="btn" onclick="doPredict()">Predict</button>
    <pre id="pr-out">—</pre>
  </div>
</div>

<div id="analyze" class="tab">
  <div class="card">
    <h3>Statistical Analysis</h3>
    <label>Data (comma-separated)</label>
    <textarea id="an-data" rows="3" placeholder="1,2,3,4,5,6,7,8,9,10"></textarea>
    <button class="btn" onclick="doAnalyze()">Analyze</button>
    <pre id="an-out">—</pre>
  </div>
</div>

<div id="random" class="tab">
  <div class="card">
    <h3>Random Math Generation</h3>
    <label>Complexity</label>
    <select id="rnd-cplx"><option>low</option><option selected>medium</option><option>high</option></select>
    <button class="btn" onclick="doRandom()">Generate</button>
    <pre id="rnd-out">—</pre>
  </div>
</div>

<div id="config" class="tab">
  <div class="card">
    <h3>Configuration</h3>
    <div id="cfg-form">Loading…</div>
    <button class="btn" onclick="saveConfig()">Save</button>
  </div>
</div>

<div id="history" class="tab">
  <div class="card">
    <h3>Recent Evaluations (DB)</h3>
    <pre id="hist-out">Loading…</pre>
  </div>
</div>

</div>
</div>

<script>
const BASE = '';
function show(id, btn) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.sidebar button').forEach(b=>b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(btn) btn.classList.add('active');
  if(id==='dashboard') refreshStats();
  if(id==='history') loadHistory();
  if(id==='config') loadConfig();
}
async function api(path, body) {
  const opts = body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {};
  const r = await fetch(BASE+path, opts);
  return r.json();
}
async function refreshStats() {
  const s = await api('/api/stats');
  document.getElementById('s-eq').textContent  = s.equations  ?? '—';
  document.getElementById('s-res').textContent = s.results    ?? '—';
  document.getElementById('s-pred').textContent= s.predictions?? '—';
  document.getElementById('s-thm').textContent = s.theorems   ?? '—';
  document.getElementById('s-db').textContent  = (s.db_size_mb??0).toFixed(2);
  document.getElementById('s-mem').textContent = ((s.memory_allocated??0)/1024/1024).toFixed(1);
}
async function doEval() {
  const r = await api('/api/evaluate',{expression:document.getElementById('ev-expr').value});
  document.getElementById('ev-out').textContent = JSON.stringify(r,null,2);
}
async function doPredict() {
  const data  = document.getElementById('pr-data').value.split(',').map(Number);
  const steps = +document.getElementById('pr-steps').value;
  const r = await api('/api/predict',{history:data,steps});
  document.getElementById('pr-out').textContent = JSON.stringify(r,null,2);
}
async function doAnalyze() {
  const data = document.getElementById('an-data').value.split(',').map(Number);
  const r = await api('/api/analyze',{data});
  document.getElementById('an-out').textContent = JSON.stringify(r,null,2);
}
async function doRandom() {
  const r = await api('/api/random',{complexity:document.getElementById('rnd-cplx').value});
  document.getElementById('rnd-out').textContent = JSON.stringify(r,null,2);
}
async function loadHistory() {
  const r = await api('/api/stats');
  document.getElementById('hist-out').textContent = JSON.stringify(r,null,2);
}
async function loadConfig() {
  const cfg = await api('/api/config');
  document.getElementById('cfg-form').innerHTML = `
    <label>DB path</label><input id="c-db" value="${cfg.database?.path??''}">
    <label>API port</label><input id="c-port" type="number" value="${cfg.api?.port??8080}">
    <label>Precision (digits)</label><input id="c-prec" type="number" value="${cfg.precision?.decimal_places??100}">
    <label>God Mode</label>
    <select id="c-god">
      <option value="true" ${cfg.god_mode?.enabled?'selected':''}>Enabled</option>
      <option value="false" ${!cfg.god_mode?.enabled?'selected':''}>Disabled</option>
    </select>`;
}
async function saveConfig() {
  const body = {
    'database.path': document.getElementById('c-db')?.value,
    'api.port': +document.getElementById('c-port')?.value,
    'precision.decimal_places': +document.getElementById('c-prec')?.value,
    'god_mode.enabled': document.getElementById('c-god')?.value==='true',
  };
  await api('/api/config/update', body);
  alert('Saved!');
}
refreshStats();
setInterval(refreshStats, 30000);
</script>
</body>
</html>"""


class _AdminHandler(http.server.BaseHTTPRequestHandler):
    engine = None

    def log_message(self, *a) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/":
            body = _ADMIN_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/stats":
            _send_json(self, self.engine.get_stats())
        elif self.path == "/api/config":
            import sys, pathlib
            sys.path.insert(0, str(pathlib.Path(__file__).parents[2]))
            from packages.config import ConfigurationManager
            cfg = ConfigurationManager()
            _send_json(self, {k: (v.__dict__ if hasattr(v, "__dict__") else v)
                               for k, v in cfg.get_all().items()})
        else:
            _send_json(self, {"error": "Not found"}, 404)

    def do_POST(self) -> None:
        data = _read_body(self)
        try:
            if self.path == "/api/evaluate":
                _send_json(self, self.engine.evaluate(data.get("expression", "")))
            elif self.path == "/api/predict":
                _send_json(self, self.engine.predict(
                    data.get("history", []), data.get("steps", 5)))
            elif self.path == "/api/analyze":
                _send_json(self, self.engine.analyze(data.get("data", [])))
            elif self.path == "/api/random":
                _send_json(self, self.engine.random_math(data.get("complexity", "medium")))
            elif self.path == "/api/config/update":
                import sys, pathlib
                sys.path.insert(0, str(pathlib.Path(__file__).parents[2]))
                from packages.config import ConfigurationManager
                cfg = ConfigurationManager()
                for key, val in data.items():
                    cfg.set(key, val)
                _send_json(self, {"status": "ok"})
            else:
                _send_json(self, {"error": "Not found"}, 404)
        except Exception as e:
            _send_json(self, {"error": str(e)}, 500)


class AdminServer:
    """Runs the admin panel in a daemon thread."""

    def __init__(self, engine, host: str = "127.0.0.1", port: int = 8081) -> None:
        self.engine = engine
        self.host   = host
        self.port   = port
        self._server = None
        _AdminHandler.engine = engine

    def start(self) -> None:
        self._server = http.server.HTTPServer((self.host, self.port), _AdminHandler)
        t = threading.Thread(target=self._server.serve_forever, daemon=True)
        t.start()
        print(f"[ADMIN] Listening on http://{self.host}:{self.port}")

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()

# ── Security: admin authentication & session management ──────────────────

import hashlib
import hmac
import secrets
import time

class AdminSecurity:
    """
    Admin panel security layer:
      - bcrypt-style PBKDF2 password hashing
      - CSRF token per session
      - Session store with TTL enforcement
      - IP allowlist support
      - Brute-force lockout (max 5 failed attempts per IP per 15 min)
      - Secure cookie attributes (HttpOnly, SameSite)
    """
    SESSION_TTL_SEC    = 3_600      # 1 hour
    MAX_FAILED_LOGINS  = 5
    LOCKOUT_SEC        = 900        # 15 minutes
    PBKDF2_ITERATIONS  = 260_000
    SALT_LEN           = 32

    _sessions:  dict = {}           # token → {user, created, csrf, ip}
    _failures:  dict = {}           # ip → (count, first_failure_ts)

    # ── Password hashing ──────────────────────────────────────────────────
    @classmethod
    def hash_password(cls, password: str) -> str:
        salt = secrets.token_bytes(cls.SALT_LEN)
        key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt,
                                    cls.PBKDF2_ITERATIONS)
        return salt.hex() + ":" + key.hex()

    @classmethod
    def verify_password(cls, password: str, stored: str) -> bool:
        try:
            salt_hex, key_hex = stored.split(":")
            salt = bytes.fromhex(salt_hex)
            key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt,
                                        cls.PBKDF2_ITERATIONS)
            return hmac.compare_digest(key.hex(), key_hex)
        except Exception:
            return False

    # ── Brute-force lockout ───────────────────────────────────────────────
    @classmethod
    def record_failure(cls, ip: str) -> None:
        now = time.time()
        count, first = cls._failures.get(ip, (0, now))
        if now - first > cls.LOCKOUT_SEC:
            count, first = 0, now
        cls._failures[ip] = (count + 1, first)

    @classmethod
    def is_locked_out(cls, ip: str) -> bool:
        count, first = cls._failures.get(ip, (0, 0))
        if time.time() - first > cls.LOCKOUT_SEC:
            cls._failures.pop(ip, None)
            return False
        return count >= cls.MAX_FAILED_LOGINS

    @classmethod
    def clear_failures(cls, ip: str) -> None:
        cls._failures.pop(ip, None)

    # ── Session management ────────────────────────────────────────────────
    @classmethod
    def create_session(cls, user: str, ip: str) -> dict:
        token = secrets.token_urlsafe(48)
        csrf  = secrets.token_hex(32)
        cls._sessions[token] = {
            "user":    user,
            "ip":      ip,
            "created": time.time(),
            "csrf":    csrf,
            "last_activity": time.time(),
        }
        return {"token": token, "csrf": csrf}

    @classmethod
    def validate_session(cls, token: str, ip: str = None) -> dict:
        s = cls._sessions.get(token)
        if not s:
            return {}
        if time.time() - s["created"] > cls.SESSION_TTL_SEC:
            cls._sessions.pop(token, None)
            return {}
        if ip and s["ip"] != ip:   # IP binding
            return {}
        s["last_activity"] = time.time()
        return s

    @classmethod
    def destroy_session(cls, token: str) -> None:
        cls._sessions.pop(token, None)

    @classmethod
    def validate_csrf(cls, token: str, csrf: str) -> bool:
        s = cls._sessions.get(token, {})
        stored = s.get("csrf", "")
        return hmac.compare_digest(stored, csrf) if stored else False

    @classmethod
    def purge_expired(cls) -> int:
        now  = time.time()
        dead = [t for t, s in cls._sessions.items()
                if now - s["created"] > cls.SESSION_TTL_SEC]
        for t in dead:
            del cls._sessions[t]
        return len(dead)

    @classmethod
    def cookie_header(cls, token: str, secure: bool = False) -> str:
        flags = "HttpOnly; SameSite=Strict; Path=/"
        if secure:
            flags += "; Secure"
        return f"admin_session={token}; {flags}"

    @classmethod
    def active_sessions(cls) -> list:
        cls.purge_expired()
        return [{"user": s["user"], "ip": s["ip"],
                 "age_sec": int(time.time()-s["created"])}
                for s in cls._sessions.values()]

    @classmethod
    def validate_origin(cls, origin: str,
                        allowed: list = None) -> bool:
        if allowed is None:
            return True
        return origin in allowed

    @classmethod
    def security_headers(cls) -> dict:
        return {
            "X-Content-Type-Options":         "nosniff",
            "X-Frame-Options":                "SAMEORIGIN",
            "X-XSS-Protection":               "1; mode=block",
            "Referrer-Policy":                "strict-origin-when-cross-origin",
            "Permissions-Policy":             "geolocation=(), microphone=()",
            "Content-Security-Policy": (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:;"
            ),
        }


# ── Standards: admin audit trail ──────────────────────────────────────────

class AdminAuditTrail:
    """
    Structured audit logging for all admin actions.
    Follows NIST SP 800-92 log management standards:
      - WHO (user, ip)
      - WHAT (action, target, parameters)
      - WHEN (ISO-8601 timestamp)
      - OUTCOME (success/failure)
    """
    _log: list = []
    MAX_LOG_ENTRIES = 10_000

    @classmethod
    def record(cls, user: str, ip: str, action: str,
               target: str = "", params: dict = None,
               success: bool = True, detail: str = "") -> None:
        entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "user":      user,
            "ip":        ip,
            "action":    action,
            "target":    target,
            "params":    params or {},
            "success":   success,
            "detail":    detail,
        }
        cls._log.append(entry)
        if len(cls._log) > cls.MAX_LOG_ENTRIES:
            cls._log = cls._log[-cls.MAX_LOG_ENTRIES:]

    @classmethod
    def recent(cls, n: int = 100) -> list:
        return cls._log[-n:]

    @classmethod
    def filter_by_user(cls, user: str) -> list:
        return [e for e in cls._log if e["user"] == user]

    @classmethod
    def filter_failures(cls) -> list:
        return [e for e in cls._log if not e["success"]]

    @classmethod
    def export_csv(cls) -> str:
        import csv, io
        buf = io.StringIO()
        if not cls._log:
            return ""
        w = csv.DictWriter(buf, fieldnames=cls._log[0].keys())
        w.writeheader(); w.writerows(cls._log)
        return buf.getvalue()

    @classmethod
    def summary(cls) -> dict:
        total = len(cls._log)
        failures = sum(1 for e in cls._log if not e["success"])
        users    = list({e["user"] for e in cls._log})
        actions  = list({e["action"] for e in cls._log})
        return {
            "total_events": total,
            "failures":     failures,
            "unique_users": users,
            "action_types": actions,
        }


# ── Standards: admin API response schema ─────────────────────────────────

class AdminResponseStandard:
    """
    Standardised JSON response envelope for all admin API responses.
    Every response carries: status, data|error, request_id, timestamp.
    """

    @staticmethod
    def success(data, request_id: str = "") -> dict:
        return {
            "status":     "success",
            "data":       data,
            "request_id": request_id,
            "timestamp":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    @staticmethod
    def error(message: str, code: int = 400,
              request_id: str = "") -> dict:
        return {
            "status":     "error",
            "error":      {"message": message, "code": code},
            "request_id": request_id,
            "timestamp":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    @staticmethod
    def paginate(items: list, page: int,
                 per_page: int) -> dict:
        start = (page-1) * per_page
        end   = start + per_page
        return {
            "items":       items[start:end],
            "total":       len(items),
            "page":        page,
            "per_page":    per_page,
            "total_pages": (len(items) + per_page - 1) // per_page,
        }
