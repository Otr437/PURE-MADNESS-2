"""
apps/admin-server/main.py — starts the admin web panel service.

Usage:
    python apps/admin-server/main.py [--host 0.0.0.0] [--admin-port 8081]
"""

import signal
import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from core import MathEngine
from packages.admin import AdminServer
from packages.config import ConfigurationManager


def main() -> None:
    cfg    = ConfigurationManager()
    engine = MathEngine()
    host   = cfg.get("admin.host", "127.0.0.1")
    port   = cfg.get("admin.port", 8081)

    server = AdminServer(engine, host=host, port=port)
    server.start()

    def _shutdown(sig, frame):
        print("\n[ADMIN] Shutting down…")
        server.stop()
        engine.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"[ADMIN] Running at http://{host}:{port}  Press Ctrl-C to stop.")
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

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from core import MathEngine
from packages.admin import AdminServer
from packages.config import ConfigurationManager
from packages.admin.server import AdminSecurity, AdminAuditTrail, AdminResponseStandard


def setup_logging(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("admin-server")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] admin-server %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ"
    ))
    if not logger.handlers:
        logger.addHandler(h)
    return logger


def _session_cleanup_thread(interval: int = 300) -> None:
    """Purge expired admin sessions every interval seconds."""
    while True:
        time.sleep(interval)
        purged = AdminSecurity.purge_expired()
        if purged:
            logging.getLogger("admin-server").debug(
                f"Purged {purged} expired admin sessions")


def _audit_flush_thread(engine, interval: int = 120) -> None:
    """Persist in-memory audit log to the database periodically."""
    while True:
        time.sleep(interval)
        try:
            for entry in AdminAuditTrail.recent(50):
                engine.db.log_audit(
                    entry.get("user", "admin"),
                    entry.get("action", ""),
                    result=json.dumps(entry.get("params", {})),
                )
        except Exception as exc:
            logging.getLogger("admin-server").warning(
                f"Audit flush error: {exc}")


class AdminServerProcess:
    """
    Full admin panel lifecycle manager.
    Handles: startup checks, default admin password init,
    background threads, graceful shutdown, and audit trail.
    """

    def __init__(self) -> None:
        self.cfg      = ConfigurationManager()
        self.logger   = setup_logging(self.cfg.get("logging.level", "INFO"))
        self.engine   = None
        self.server   = None
        self._running = True
        self._start_time = time.time()

    def _ensure_default_password(self) -> None:
        """Set a hashed default password if none configured."""
        pw_hash = self.cfg.get("admin.password_hash", "")
        if not pw_hash:
            default_pw = "admin"
            new_hash   = AdminSecurity.hash_password(default_pw)
            self.cfg.set("admin.password_hash", new_hash)
            self.logger.warning(
                "No admin password set — default 'admin' configured. "
                "Change immediately via config or UI."
            )

    def build(self) -> None:
        self.logger.info("Initialising MathEngine for admin panel…")
        self.engine = MathEngine()
        self._ensure_default_password()

        host = self.cfg.get("admin.host", "127.0.0.1")
        port = self.cfg.get("admin.port", 8081)
        self.server = AdminServer(self.engine, host=host, port=port)
        self.logger.info(f"Admin panel configured on {host}:{port}")

    def start(self) -> None:
        self.build()

        threading.Thread(
            target=_session_cleanup_thread,
            args=(300,), daemon=True, name="session-cleanup"
        ).start()
        threading.Thread(
            target=_audit_flush_thread,
            args=(self.engine, 120), daemon=True, name="audit-flush"
        ).start()

        self.server.start()
        self.logger.info("Admin panel started — ready")
        AdminAuditTrail.record("system", "0.0.0.0", "server_start",
                                detail=f"Admin panel started on port "
                                       f"{self.cfg.get('admin.port',8081)}")
        self._register_signals()
        self._block()

    def _register_signals(self) -> None:
        signal.signal(signal.SIGINT,  self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

    def _shutdown(self, sig, frame) -> None:
        self.logger.info(f"Signal {sig} — shutting down admin panel")
        AdminAuditTrail.record("system", "0.0.0.0", "server_stop",
                                detail=f"Uptime {int(time.time()-self._start_time)}s")
        self._running = False
        if self.server:
            self.server.stop()
        if self.engine:
            self.engine.stop()
        sys.exit(0)

    def _block(self) -> None:
        while self._running:
            time.sleep(1)


# ── Security: admin startup hardening ────────────────────────────────────

class AdminStartupHardening:
    """
    Enforces security baseline before the admin panel accepts connections.
    Logs warnings for insecure configurations; blocks on critical failures.
    """

    @staticmethod
    def warn_if_default_password(cfg: ConfigurationManager,
                                  logger: logging.Logger) -> None:
        pw_hash = cfg.get("admin.password_hash", "")
        if not pw_hash:
            logger.warning("SECURITY: admin password not set")
        elif AdminSecurity.verify_password("admin", pw_hash):
            logger.warning("SECURITY: default 'admin' password in use — change immediately")

    @staticmethod
    def warn_if_public_bind(cfg: ConfigurationManager,
                             logger: logging.Logger) -> None:
        host = cfg.get("admin.host", "127.0.0.1")
        if host in ("0.0.0.0", "::", ""):
            logger.warning(
                "SECURITY: admin panel bound to all interfaces — "
                "restrict to localhost in production"
            )

    @staticmethod
    def warn_if_no_ssl(cfg: ConfigurationManager,
                        logger: logging.Logger) -> None:
        if not cfg.get("api.ssl_enabled", False):
            logger.info("TLS not enabled — acceptable for localhost; "
                        "enable ssl_enabled=true for remote access")

    @staticmethod
    def warn_if_auth_disabled(cfg: ConfigurationManager,
                               logger: logging.Logger) -> None:
        if not cfg.get("admin.require_auth", True):
            logger.warning("SECURITY: admin.require_auth=False — panel is unauthenticated")

    @classmethod
    def run_all(cls, cfg: ConfigurationManager,
                logger: logging.Logger) -> None:
        cls.warn_if_default_password(cfg, logger)
        cls.warn_if_public_bind(cfg, logger)
        cls.warn_if_no_ssl(cfg, logger)
        cls.warn_if_auth_disabled(cfg, logger)


# ── Standards: admin panel feature manifest ───────────────────────────────

ADMIN_FEATURES = {
    "dashboard": {
        "description": "Live system statistics and recent activity",
        "refresh_interval_sec": 30,
        "metrics": ["equations","results","predictions","theorems",
                    "db_size_mb","memory_utilization","random_entropy"],
    },
    "evaluate": {
        "description": "Inline expression evaluator with result display",
        "max_expression_len": 8192,
    },
    "predict": {
        "description": "Time-series forecasting with auto-train",
        "max_history_points": 10_000,
        "max_steps": 500,
    },
    "analyze": {
        "description": "Full descriptive statistics, outlier detection, and regression",
        "max_data_points": 100_000,
    },
    "random": {
        "description": "Random mathematical expression generator",
        "complexity_levels": ["low", "medium", "high"],
    },
    "config": {
        "description": "Runtime configuration editor",
        "editable_fields": ["database.path","api.port","precision.decimal_places",
                            "god_mode.enabled","logging.level"],
    },
    "history": {
        "description": "Recent evaluation history from the database",
        "max_rows": 1000,
    },
    "theorems": {
        "description": "Theorem registry — view, register, and manage theorems",
        "max_display": 500,
    },
    "audit": {
        "description": "Admin action audit trail",
        "retention_days": 90,
    },
    "sessions": {
        "description": "Active session management",
        "session_ttl_sec": 3600,
    },
}


ADMIN_ROUTES = {
    "GET  /":                   "Render admin dashboard HTML",
    "GET  /api/stats":          "JSON engine statistics",
    "GET  /api/config":         "JSON config dump",
    "POST /api/evaluate":       "Evaluate expression",
    "POST /api/predict":        "Time-series prediction",
    "POST /api/analyze":        "Statistical analysis",
    "POST /api/random":         "Random math generation",
    "POST /api/config/update":  "Update config key",
    "GET  /api/audit":          "Audit log (last 100 entries)",
    "GET  /api/sessions":       "Active admin sessions",
    "POST /api/auth/login":     "Authenticate and obtain session token",
    "POST /api/auth/logout":    "Destroy session",
}


if __name__ == "__main__":
    cfg    = ConfigurationManager()
    logger = setup_logging(cfg.get("logging.level", "INFO"))

    AdminStartupHardening.run_all(cfg, logger)

    proc = AdminServerProcess()
    proc.start()
