"""
apps/api-server/main.py — starts the REST API service.

Usage:
    python apps/api-server/main.py [--host 0.0.0.0] [--port 8080]
"""

import signal
import sys
import time
from pathlib import Path

# Resolve repo root so we can import packages
_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from core import MathEngine
from packages.api import APIServer
from packages.config import ConfigurationManager


def main() -> None:
    cfg    = ConfigurationManager()
    engine = MathEngine()
    host   = cfg.get("api.host", "127.0.0.1")
    port   = cfg.get("api.port", 8080)

    server = APIServer(engine, host=host, port=port)
    server.start()

    def _shutdown(sig, frame):
        print("\n[API] Shutting down…")
        server.stop()
        engine.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"[API] Running. Press Ctrl-C to stop.")
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()


import sys
import time
import json
import logging
import signal
import threading
from pathlib import Path

# ── Extended API server startup ───────────────────────────────────────────

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from core import MathEngine
from packages.api import APIServer
from packages.config import ConfigurationManager
from packages.api.server import APISecurityLayer, API_SPEC


def setup_logging(level: str = "INFO") -> logging.Logger:
    """Configure structured logging for the API server process."""
    logger = logging.getLogger("api-server")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] api-server %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ"
    ))
    if not logger.handlers:
        logger.addHandler(handler)
    return logger


def _heartbeat_thread(engine, logger: logging.Logger,
                       interval: int = 60) -> None:
    """Log engine stats every `interval` seconds."""
    while True:
        time.sleep(interval)
        try:
            stats = engine.get_stats()
            logger.info(
                f"heartbeat equations={stats.get('equations',0)} "
                f"results={stats.get('results',0)} "
                f"mem_util={stats.get('memory_utilization',0):.2%}"
            )
        except Exception as exc:
            logger.warning(f"heartbeat error: {exc}")


def _purge_rate_limits_thread(interval: int = 300) -> None:
    """Periodically purge stale rate-limit buckets."""
    while True:
        time.sleep(interval)
        APISecurityLayer.purge_old_buckets()


def _preload_engine(engine, logger: logging.Logger) -> None:
    """Warm up engine caches before accepting traffic."""
    warmup_exprs = [
        "sqrt(2)", "sin(pi/4)", "log(e)", "2**10",
        "3.14159 * 2", "factorial(10)",
    ]
    for expr in warmup_exprs:
        try:
            engine.evaluate(expr)
        except Exception:
            pass
    logger.info(f"Warmup complete — {len(warmup_exprs)} expressions pre-evaluated")


class APIServerProcess:
    """
    Full API server lifecycle manager.
    Handles startup, signal trapping, graceful shutdown,
    and optional TLS termination.
    """

    def __init__(self) -> None:
        self.cfg     = ConfigurationManager()
        self.logger  = setup_logging(self.cfg.get("logging.level", "INFO"))
        self.engine  = None
        self.server  = None
        self._running = True

    def build(self) -> None:
        """Initialise engine and HTTP server."""
        self.logger.info("Initialising MathEngine…")
        self.engine = MathEngine()

        host = self.cfg.get("api.host", "127.0.0.1")
        port = self.cfg.get("api.port", 8080)
        self.server = APIServer(self.engine, host=host, port=port)
        self.logger.info(f"API server configured on {host}:{port}")

    def start(self) -> None:
        """Start server, background threads, and block."""
        self.build()

        # Pre-load
        _preload_engine(self.engine, self.logger)

        # Background threads
        threading.Thread(
            target=_heartbeat_thread,
            args=(self.engine, self.logger, 60),
            daemon=True, name="heartbeat"
        ).start()
        threading.Thread(
            target=_purge_rate_limits_thread,
            args=(300,),
            daemon=True, name="rate-limit-purge"
        ).start()

        # Start HTTP server
        self.server.start()
        self.logger.info("API server started — ready to serve")
        self._register_signals()
        self._block()

    def _register_signals(self) -> None:
        signal.signal(signal.SIGINT,  self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

    def _shutdown(self, sig, frame) -> None:
        self.logger.info(f"Received signal {sig} — shutting down gracefully")
        self._running = False
        if self.server:
            self.server.stop()
        if self.engine:
            self.engine.stop()
        sys.exit(0)

    def _block(self) -> None:
        while self._running:
            time.sleep(1)

    def health_check(self) -> dict:
        """Return current health state."""
        stats = self.engine.get_stats() if self.engine else {}
        return {
            "status":    "healthy",
            "uptime_s":  round(time.time() - self._start_time, 1),
            "equations": stats.get("equations", 0),
            "memory":    stats.get("memory_utilization", 0),
        }


# ── Security: server startup validation ──────────────────────────────────

class APIStartupValidator:
    """
    Validates the runtime environment before the API server accepts traffic.
    Fails fast on misconfiguration rather than serving broken responses.
    """

    @staticmethod
    def check_port_available(host: str, port: int) -> bool:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            result = s.connect_ex((host, port))
            return result != 0   # 0 means port is already in use

    @staticmethod
    def check_python_version(min_major: int = 3,
                              min_minor: int = 9) -> bool:
        return sys.version_info >= (min_major, min_minor)

    @staticmethod
    def check_required_packages() -> dict:
        required = ["yaml", "numpy", "scipy", "sklearn", "sympy"]
        status   = {}
        for pkg in required:
            try:
                __import__(pkg)
                status[pkg] = "ok"
            except ImportError:
                status[pkg] = "MISSING"
        return status

    @staticmethod
    def check_db_writable(db_path: str) -> bool:
        import os
        parent = Path(db_path).parent
        return os.access(str(parent), os.W_OK)

    @staticmethod
    def check_memory_available(required_mb: int = 256) -> bool:
        try:
            import psutil
            available = psutil.virtual_memory().available / (1024 * 1024)
            return available >= required_mb
        except ImportError:
            return True   # can't check, assume ok

    @classmethod
    def run_all(cls, cfg: ConfigurationManager) -> dict:
        host    = cfg.get("api.host", "127.0.0.1")
        port    = cfg.get("api.port", 8080)
        db_path = cfg.get("database.path", "math_engine.db")
        results = {
            "python_version":  cls.check_python_version(),
            "port_available":  cls.check_port_available(host, port),
            "db_writable":     cls.check_db_writable(db_path),
            "memory_ok":       cls.check_memory_available(),
            "packages":        cls.check_required_packages(),
        }
        results["all_pass"] = (
            results["python_version"] and
            results["port_available"] and
            results["db_writable"] and
            results["memory_ok"] and
            all(v == "ok" for v in results["packages"].values())
        )
        return results


# ── Standards: API server configuration schema ────────────────────────────

API_SERVER_DEFAULTS = {
    "host":               "127.0.0.1",
    "port":               8080,
    "workers":            4,
    "max_request_mb":     10,
    "rate_limit":         200,
    "rate_window_sec":    60,
    "cors_origins":       ["*"],
    "ssl_enabled":        False,
    "log_level":          "INFO",
    "heartbeat_interval": 60,
    "warmup_enabled":     True,
    "shutdown_timeout":   30,
}

API_RESPONSE_HEADERS = {
    "Content-Type":              "application/json",
    "X-Content-Type-Options":    "nosniff",
    "X-Frame-Options":           "DENY",
    "Cache-Control":             "no-store",
    "X-Request-ID":              "",   # filled per-request
}

API_ERROR_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    413: "PAYLOAD_TOO_LARGE",
    422: "UNPROCESSABLE_ENTITY",
    429: "RATE_LIMITED",
    500: "INTERNAL_SERVER_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


def format_error_response(status: int, detail: str,
                            request_id: str = "") -> dict:
    return {
        "error":      API_ERROR_CODES.get(status, "UNKNOWN"),
        "status":     status,
        "detail":     detail,
        "request_id": request_id,
    }


if __name__ == "__main__":
    validator = APIStartupValidator()
    cfg       = ConfigurationManager()
    checks    = validator.run_all(cfg)

    if not checks["all_pass"]:
        print("[STARTUP] Pre-flight checks failed:")
        for k, v in checks.items():
            if v is not True and v != "ok" and k != "packages":
                print(f"  ✗ {k}: {v}")
        for pkg, status in checks.get("packages", {}).items():
            if status != "ok":
                print(f"  ✗ package {pkg}: {status}")
        sys.exit(1)

    proc = APIServerProcess()
    proc._start_time = time.time()
    proc.start()
