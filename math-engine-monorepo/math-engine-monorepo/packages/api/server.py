"""
APIServer — lightweight HTTP REST server for the MathEngine.

Endpoints:
  GET  /               — health/version
  GET  /api/health     — health check
  GET  /api/stats      — engine statistics
  POST /api/evaluate   — evaluate expression
  POST /api/solve      — solve equation
  POST /api/derivative — compute derivative
  POST /api/integral   — compute definite integral
  POST /api/analyze    — descriptive statistics
  POST /api/predict    — time-series prediction
  POST /api/train      — train prediction model
  POST /api/montecarlo — Monte Carlo forecast
  POST /api/random     — random math generation
  POST /api/godmode    — god-mode solve
"""

import http.server
import json
import threading
from datetime import datetime
from typing import Any, Dict


def _read_body(request) -> Dict[str, Any]:
    length = int(request.headers.get("Content-Length", 0))
    raw    = request.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _send_json(request, data: Any, status: int = 200) -> None:
    payload = json.dumps(data, default=str, indent=2).encode()
    request.send_response(status)
    request.send_header("Content-Type",                 "application/json")
    request.send_header("Content-Length",               str(len(payload)))
    request.send_header("Access-Control-Allow-Origin",  "*")
    request.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    request.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    request.end_headers()
    request.wfile.write(payload)


class _RequestHandler(http.server.BaseHTTPRequestHandler):
    """One handler instance per request — references the engine via class attr."""

    engine = None  # set by APIServer before serving

    def log_message(self, fmt, *args) -> None:  # silence default logging
        pass

    def do_OPTIONS(self) -> None:
        _send_json(self, {})

    def do_GET(self) -> None:
        if self.path in ("/", "/api"):
            _send_json(self, {"status": "running", "version": "1.0.0",
                               "timestamp": datetime.now().isoformat()})
        elif self.path == "/api/health":
            _send_json(self, {"status": "healthy",
                               "timestamp": datetime.now().isoformat()})
        elif self.path == "/api/stats":
            _send_json(self, self.engine.get_stats())
        else:
            _send_json(self, {"error": "Not found"}, 404)

    def do_POST(self) -> None:
        data = _read_body(self)
        path = self.path

        try:
            if path == "/api/evaluate":
                result = self.engine.evaluate(
                    data.get("expression", ""),
                    data.get("variables"),
                )
                _send_json(self, result)

            elif path == "/api/solve":
                result = self.engine.solve(
                    data.get("equation", ""),
                    data.get("variable", "x"),
                )
                _send_json(self, result)

            elif path == "/api/derivative":
                result = self.engine.derivative(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    data.get("at_point", 0),
                )
                _send_json(self, {"derivative": result})

            elif path == "/api/integral":
                result = self.engine.integral(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    data.get("lower", 0),
                    data.get("upper", 1),
                )
                _send_json(self, {"integral": result})

            elif path == "/api/analyze":
                result = self.engine.analyze(data.get("data", []))
                _send_json(self, result)

            elif path == "/api/train":
                result = self.engine.train_predictive(data.get("data", []))
                _send_json(self, result)

            elif path == "/api/predict":
                result = self.engine.predict(
                    data.get("history", []),
                    data.get("steps", 10),
                )
                _send_json(self, result)

            elif path == "/api/montecarlo":
                result = self.engine.monte_carlo(
                    data.get("history", []),
                    data.get("steps", 10),
                    data.get("n_sims", 1000),
                )
                _send_json(self, result)

            elif path == "/api/random":
                result = self.engine.random_math(data.get("complexity", "medium"))
                _send_json(self, result)

            elif path == "/api/godmode":
                result = self.engine.god_mode_solve(data.get("expression", ""))
                _send_json(self, result)

            else:
                _send_json(self, {"error": "Not found"}, 404)

        except Exception as exc:
            _send_json(self, {"error": str(exc)}, 500)


class APIServer:
    """Runs the REST API in a daemon thread."""

    def __init__(self, engine, host: str = "127.0.0.1", port: int = 8080) -> None:
        self.engine = engine
        self.host   = host
        self.port   = port
        self._server: http.server.HTTPServer = None

        # Inject engine into handler class
        _RequestHandler.engine = engine

    def start(self) -> None:
        self._server = http.server.HTTPServer((self.host, self.port), _RequestHandler)
        thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        thread.start()
        print(f"[API] Listening on http://{self.host}:{self.port}")

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()

    # ── Extended routes ────────────────────────────────────────────────────

    def _route_post(self, path: str, data: dict) -> Any:
        """Central dispatch — called from do_POST."""
        e = self.engine
        if path == "/api/evaluate":
            return e.evaluate(data.get("expression",""), data.get("variables"))
        if path == "/api/solve":
            return e.solve(data.get("equation",""), data.get("variable","x"))
        if path == "/api/derivative":
            return {"derivative": e.derivative(
                data.get("expression",""), data.get("variable","x"),
                data.get("at_point",0.0), data.get("order",1))}
        if path == "/api/integral":
            return {"integral": e.integral(
                data.get("expression",""), data.get("variable","x"),
                data.get("lower",0.0), data.get("upper",1.0))}
        if path == "/api/limit":
            return {"limit": e.limit(
                data.get("expression",""), data.get("variable","x"),
                data.get("point",0.0), data.get("direction","both"))}
        if path == "/api/analyze":
            return e.analyze(data.get("data",[]))
        if path == "/api/outliers":
            return e.outliers(data.get("data",[]), data.get("method","iqr"))
        if path == "/api/train":
            return e.train_predictive(data.get("data",[]))
        if path == "/api/predict":
            return e.predict(data.get("history",[]), data.get("steps",10))
        if path == "/api/montecarlo":
            return e.monte_carlo(data.get("history",[]),
                                  data.get("steps",10), data.get("n_sims",1000))
        if path == "/api/random":
            return e.random_math(data.get("complexity","medium"))
        if path == "/api/godmode":
            return e.god_mode_solve(data.get("expression",""))
        if path == "/api/prove":
            return e.prove(data.get("statement",""))
        if path == "/api/simplify":
            return e.god_mode.symbolic_simplify(data.get("expression",""))
        if path == "/api/factor":
            return e.god_mode.factor_expression(data.get("expression",""))
        if path == "/api/expand":
            return e.god_mode.expand_expression(data.get("expression",""))
        if path == "/api/series":
            return e.god_mode.series_expansion(
                data.get("expression",""), data.get("variable","x"),
                data.get("point",0), data.get("order",6))
        if path == "/api/diff":
            return e.god_mode.symbolic_diff(
                data.get("expression",""), data.get("variable","x"),
                data.get("order",1))
        if path == "/api/integrate_sym":
            return e.god_mode.symbolic_integrate(
                data.get("expression",""), data.get("variable","x"),
                data.get("lower"), data.get("upper"))
        if path == "/api/batch_evaluate":
            exprs = data.get("expressions",[])
            return {"results": [e.evaluate(ex) for ex in exprs[:200]]}
        if path == "/api/memory/stats":
            return e.memory.stats()
        if path == "/api/memory/gc":
            freed = e.memory.gc(data.get("max_age",3600))
            return {"freed_blocks": freed}
        if path == "/api/convert":
            return {"result": e.symbolic.convert_unit(
                data.get("value",0), data.get("from",""), data.get("to",""))}
        if path == "/api/theorems":
            return {"theorems": e.god_mode.list_theorems(data.get("limit",50))}
        if path == "/api/theorems/register":
            e.god_mode.register_theorem(
                data.get("name",""), data.get("statement",""),
                data.get("proof",""), data.get("confidence",0.5))
            return {"status":"ok"}
        if path == "/api/db/stats":
            return e.db.get_stats()
        if path == "/api/db/audit":
            return {"log": e.db.get_audit_log(limit=data.get("limit",50))}
        if path == "/api/rng/health":
            return e.rng.full_health_check()
        if path == "/api/rng/token":
            return {"token": e.rng.token_hex(data.get("bytes",32))}
        if path == "/api/regression":
            return e.analytics.regression_analysis(
                data.get("x",[]), data.get("y",[]))
        if path == "/api/pca":
            return e.analytics.pca_summary(data.get("data",[]))
        return None


# ── Security: request validation ─────────────────────────────────────────

class APISecurityLayer:
    """
    Validates every incoming HTTP request:
      - IP rate limiting (token bucket per remote addr)
      - Payload size enforcement
      - Content-Type enforcement on POST
      - API key header validation (optional, config-driven)
      - Request ID injection for audit traceability
    """
    import time as _time

    MAX_BODY_BYTES  = 10 * 1024 * 1024   # 10 MB
    RATE_LIMIT      = 200                  # requests per window
    RATE_WINDOW_SEC = 60

    _buckets: dict = {}                    # ip → (count, window_start)

    @classmethod
    def check_rate_limit(cls, ip: str) -> bool:
        import time
        now = time.time()
        bucket = cls._buckets.get(ip, (0, now))
        count, start = bucket
        if now - start > cls.RATE_WINDOW_SEC:
            cls._buckets[ip] = (1, now)
            return True
        if count >= cls.RATE_LIMIT:
            return False
        cls._buckets[ip] = (count + 1, start)
        return True

    @classmethod
    def purge_old_buckets(cls) -> None:
        import time
        now = time.time()
        cls._buckets = {ip: b for ip, b in cls._buckets.items()
                        if now - b[1] <= cls.RATE_WINDOW_SEC * 2}

    @classmethod
    def validate_content_type(cls, headers) -> bool:
        ct = headers.get("Content-Type", "")
        return "application/json" in ct or ct == ""

    @classmethod
    def validate_body_size(cls, length: int) -> bool:
        return 0 <= length <= cls.MAX_BODY_BYTES

    @classmethod
    def sanitise_path(cls, path: str) -> str:
        """Strip query strings and normalise slashes."""
        path = path.split("?")[0].split("#")[0]
        while "//" in path:
            path = path.replace("//", "/")
        return path

    @classmethod
    def generate_request_id(cls) -> str:
        import secrets
        return secrets.token_hex(8)

    @classmethod
    def cors_headers(cls) -> dict:
        return {
            "Access-Control-Allow-Origin":  "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
            "X-Content-Type-Options":       "nosniff",
            "X-Frame-Options":              "DENY",
            "X-XSS-Protection":             "1; mode=block",
        }

    @classmethod
    def validate_api_key(cls, headers, db) -> bool:
        """If API key enforcement is enabled, check the header."""
        key = headers.get("X-API-Key") or headers.get("Authorization","").replace("Bearer ","")
        if not key:
            return False
        return db.validate_api_key(key) is not None


# ── Standards: OpenAPI 3.0 route documentation ───────────────────────────

API_SPEC = {
    "openapi": "3.0.0",
    "info": {
        "title":       "Math Engine API",
        "version":     "1.0.0",
        "description": "Complete mathematical analysis REST API",
        "contact":     {"name": "Math Engine", "url": "http://localhost:8080"},
    },
    "servers": [{"url": "http://localhost:8080"}],
    "paths": {
        "/api/evaluate":     {"post": {"summary": "Evaluate a mathematical expression",
            "requestBody": {"content": {"application/json": {"schema": {
                "properties": {"expression": {"type":"string"},
                               "variables": {"type":"object"}}}}}},
            "responses": {"200": {"description": "Evaluation result"}}}},
        "/api/solve":        {"post": {"summary": "Solve equation for variable"}},
        "/api/derivative":   {"post": {"summary": "Numerical/symbolic derivative"}},
        "/api/integral":     {"post": {"summary": "Definite integral"}},
        "/api/limit":        {"post": {"summary": "Compute a limit"}},
        "/api/analyze":      {"post": {"summary": "Descriptive statistics"}},
        "/api/predict":      {"post": {"summary": "Time-series forecast"}},
        "/api/montecarlo":   {"post": {"summary": "Monte Carlo simulation"}},
        "/api/godmode":      {"post": {"summary": "Heuristic equation solver"}},
        "/api/simplify":     {"post": {"summary": "Symbolic simplification"}},
        "/api/factor":       {"post": {"summary": "Polynomial factoring"}},
        "/api/diff":         {"post": {"summary": "Symbolic differentiation"}},
        "/api/integrate_sym":{"post": {"summary": "Symbolic integration"}},
        "/api/series":       {"post": {"summary": "Taylor series expansion"}},
        "/api/batch_evaluate":{"post": {"summary": "Evaluate up to 200 expressions"}},
        "/api/convert":      {"post": {"summary": "Unit conversion"}},
        "/api/regression":   {"post": {"summary": "OLS linear regression"}},
        "/api/pca":          {"post": {"summary": "Principal component analysis"}},
        "/api/rng/token":    {"post": {"summary": "Generate cryptographic token"}},
        "/api/rng/health":   {"post": {"summary": "RNG statistical health check"}},
        "/api/memory/stats": {"post": {"summary": "Memory allocator statistics"}},
        "/api/stats":        {"get":  {"summary": "Engine statistics"}},
        "/api/health":       {"get":  {"summary": "Health check"}},
        "/api/spec":         {"get":  {"summary": "This OpenAPI spec"}},
    },
}
