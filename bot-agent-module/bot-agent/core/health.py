"""
Health Check & Observability — May 30, 2026
Liveness probe, readiness, metrics endpoint, structured logging,
session registry, graceful shutdown handler.
"""

import asyncio
import json
import logging
import os
import signal
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger("health")


@dataclass
class Metric:
    name:      str
    value:     float
    unit:      str  = ""
    tags:      dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {"name": self.name, "value": self.value,
                "unit": self.unit, "tags": self.tags,
                "ts": round(self.timestamp, 3)}


class MetricsCollector:
    """In-process metrics: counters, gauges, histograms."""

    def __init__(self):
        self._counters:   dict[str, float] = {}
        self._gauges:     dict[str, float] = {}
        self._histograms: dict[str, list[float]] = {}
        self._started:    float = time.time()

    def inc(self, name: str, value: float = 1.0, tags: dict | None = None):
        self._counters[name] = self._counters.get(name, 0.0) + value

    def gauge(self, name: str, value: float):
        self._gauges[name] = value

    def observe(self, name: str, value: float):
        if name not in self._histograms:
            self._histograms[name] = []
        self._histograms[name].append(value)
        if len(self._histograms[name]) > 1000:
            self._histograms[name] = self._histograms[name][-1000:]

    def histogram_summary(self, name: str) -> dict:
        vals = self._histograms.get(name, [])
        if not vals:
            return {}
        s = sorted(vals)
        n = len(s)
        return {
            "count":  n,
            "min":    round(s[0], 3),
            "max":    round(s[-1], 3),
            "mean":   round(sum(s) / n, 3),
            "p50":    round(s[n // 2], 3),
            "p95":    round(s[int(n * 0.95)], 3),
            "p99":    round(s[int(n * 0.99)], 3),
        }

    def snapshot(self) -> dict:
        uptime = round(time.time() - self._started, 1)
        hists  = {k: self.histogram_summary(k) for k in self._histograms}
        return {
            "uptime_s":   uptime,
            "counters":   dict(self._counters),
            "gauges":     dict(self._gauges),
            "histograms": hists,
        }


class SessionRegistry:
    """Track all active and recent agent sessions."""

    def __init__(self, max_history: int = 200):
        self._active:  dict[str, dict] = {}
        self._history: list[dict]      = []
        self._max      = max_history

    def register(self, session_id: str, task: str, model: str, tags: list | None = None):
        self._active[session_id] = {
            "session_id": session_id,
            "task":       task[:100],
            "model":      model,
            "tags":       tags or [],
            "started_at": time.time(),
            "status":     "running",
        }

    def update(self, session_id: str, status: str, result: Any = None,
               tokens: int = 0, cost_usd: float = 0.0):
        entry = self._active.get(session_id)
        if entry:
            entry["status"]   = status
            entry["ended_at"] = time.time()
            entry["duration"] = round(entry["ended_at"] - entry["started_at"], 2)
            entry["tokens"]   = tokens
            entry["cost_usd"] = round(cost_usd, 5)
            if result:
                entry["result_preview"] = str(result)[:150]
            if status in ("complete", "failed", "budget_hit", "cancelled"):
                self._history.append(entry)
                if len(self._history) > self._max:
                    self._history = self._history[-self._max:]
                del self._active[session_id]

    def active(self) -> list[dict]:
        return list(self._active.values())

    def recent(self, n: int = 20) -> list[dict]:
        return sorted(self._history, key=lambda x: x.get("ended_at", 0), reverse=True)[:n]

    def stats(self) -> dict:
        all_done = [s for s in self._history]
        done     = [s for s in all_done if s["status"] == "complete"]
        failed   = [s for s in all_done if s["status"] in ("failed", "budget_hit")]
        durations= [s["duration"] for s in all_done if "duration" in s]
        return {
            "active":        len(self._active),
            "total_done":    len(done),
            "total_failed":  len(failed),
            "success_rate":  round(len(done) / max(len(all_done), 1) * 100, 1),
            "avg_duration_s":round(sum(durations) / max(len(durations), 1), 2),
            "total_tokens":  sum(s.get("tokens", 0) for s in all_done),
            "total_cost_usd":round(sum(s.get("cost_usd", 0) for s in all_done), 4),
        }


class HealthServer:
    """
    Lightweight HTTP health/metrics server (no dependencies).
    Endpoints:
      GET /health   → liveness probe
      GET /ready    → readiness probe
      GET /metrics  → full metrics snapshot
      GET /sessions → active + recent sessions
    """

    def __init__(
        self,
        port:       int = 8765,
        metrics:    MetricsCollector | None = None,
        registry:   SessionRegistry | None  = None,
        checks:     dict[str, Callable] | None = None,   # name → async fn returning bool
    ):
        self.port     = port
        self.metrics  = metrics  or MetricsCollector()
        self.registry = registry or SessionRegistry()
        self._checks  = checks or {}
        self._server  = None
        self._started = time.time()

    async def start(self):
        import asyncio
        self._server = await asyncio.start_server(
            self._handle, "0.0.0.0", self.port
        )
        logger.info(f"[HEALTH] Server on http://0.0.0.0:{self.port}")

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            data    = await reader.read(1024)
            request = data.decode(errors="replace")
            path    = request.split(" ")[1].split("?")[0] if " " in request else "/"

            if path == "/health":
                body = json.dumps({"status": "ok", "uptime_s": round(time.time() - self._started, 1)})
                code = 200
            elif path == "/ready":
                ready, details = await self._readiness()
                body = json.dumps({"ready": ready, "checks": details})
                code = 200 if ready else 503
            elif path == "/metrics":
                body = json.dumps(self.metrics.snapshot(), indent=2)
                code = 200
            elif path == "/sessions":
                body = json.dumps({
                    "active":  self.registry.active(),
                    "recent":  self.registry.recent(10),
                    "stats":   self.registry.stats(),
                }, indent=2, default=str)
                code = 200
            else:
                body = json.dumps({"error": "not found", "paths": ["/health","/ready","/metrics","/sessions"]})
                code = 404

            response = (
                f"HTTP/1.1 {code} {'OK' if code==200 else 'ERROR'}\r\n"
                f"Content-Type: application/json\r\n"
                f"Content-Length: {len(body.encode())}\r\n"
                f"Connection: close\r\n\r\n"
                f"{body}"
            )
            writer.write(response.encode())
            await writer.drain()
        except Exception as e:
            logger.warning(f"[HEALTH] Request error: {e}")
        finally:
            writer.close()

    async def _readiness(self) -> tuple[bool, dict]:
        details = {}
        for name, check_fn in self._checks.items():
            try:
                result = await check_fn() if asyncio.iscoroutinefunction(check_fn) else check_fn()
                details[name] = {"ok": bool(result)}
            except Exception as e:
                details[name] = {"ok": False, "error": str(e)}
        ready = all(v["ok"] for v in details.values()) if details else True
        return ready, details


class GracefulShutdown:
    """
    Handle SIGTERM/SIGINT cleanly.
    Waits for active sessions to finish (up to timeout).
    """

    def __init__(self, registry: SessionRegistry, timeout_s: float = 30.0):
        self._registry  = registry
        self._timeout   = timeout_s
        self._shutdown  = asyncio.Event()
        self._callbacks: list[Callable] = []

    def register_cleanup(self, fn: Callable):
        self._callbacks.append(fn)

    def setup_signals(self):
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._trigger)
            except (NotImplementedError, OSError):
                signal.signal(sig, lambda s, f: self._trigger())

    def _trigger(self):
        if not self._shutdown.is_set():
            logger.info("[SHUTDOWN] Signal received — initiating graceful shutdown")
            self._shutdown.set()

    async def wait(self):
        await self._shutdown.wait()
        logger.info("[SHUTDOWN] Waiting for active sessions...")

        deadline = time.time() + self._timeout
        while self._registry.active() and time.time() < deadline:
            active = self._registry.active()
            logger.info(f"[SHUTDOWN] {len(active)} session(s) still running...")
            await asyncio.sleep(1.0)

        if self._registry.active():
            logger.warning("[SHUTDOWN] Timeout — forcing shutdown with active sessions")
        else:
            logger.info("[SHUTDOWN] All sessions complete")

        for cb in self._callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb()
                else:
                    cb()
            except Exception as e:
                logger.warning(f"[SHUTDOWN] Cleanup callback error: {e}")

        logger.info("[SHUTDOWN] Done")


def setup_logging(
    level: str = "INFO",
    log_file: str = "",
    structured: bool = False,
) -> logging.Logger:
    """Configure structured or plain logging for the whole system."""
    fmt = (
        '{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}'
        if structured else
        "%(asctime)s [%(name)-14s] %(levelname)-7s %(message)s"
    )
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        os.makedirs(os.path.dirname(log_file) or ".", exist_ok=True)
        handlers.append(logging.FileHandler(log_file))

    logging.basicConfig(
        level   = getattr(logging, level.upper(), logging.INFO),
        format  = fmt,
        datefmt = "%H:%M:%S",
        handlers= handlers,
        force   = True,
    )
    # Quieten noisy libs
    for noisy in ("httpx", "httpcore", "anthropic", "openai", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    root = logging.getLogger("bot_agent")
    root.info(f"[LOGGING] Configured | level={level} | structured={structured}")
    return root
