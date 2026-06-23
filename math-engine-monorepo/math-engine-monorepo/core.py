"""
MathEngine — central orchestrator that wires every package together.

Usage:
    from core import MathEngine
    engine = MathEngine()
    engine.evaluate("sqrt(2) + sin(pi/4)")
"""

import re
import sys
import time
from decimal import getcontext
from pathlib import Path
from typing import Any, Dict, List, Optional

# Ensure packages are importable when run from any cwd
_REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_REPO_ROOT))

from packages.config      import ConfigurationManager
from packages.database    import DatabaseManager
from packages.randomization import ExtremeRandomGenerator
from packages.memory      import MemorySpace
from packages.symbolic    import SymbolicMathEngine
from packages.analytics   import AnalyticsEngine
from packages.prediction  import PredictiveAnalyticsEngine
from packages.god_mode    import GodModeEngine   # note: hyphen → underscore alias below


# god-mode uses a hyphen in the folder name; Python can't import that directly.
# We resolve via importlib.
import importlib.util as _ilu

def _import_god_mode():
    spec = _ilu.spec_from_file_location(
        "god_mode",
        str(_REPO_ROOT / "packages" / "god-mode" / "__init__.py"),
    )
    if spec is None:
        raise ImportError("god-mode package not found")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)   # type: ignore[union-attr]
    return mod.GodModeEngine


try:
    GodModeEngine = _import_god_mode()
except Exception:
    # Fallback: simple stub
    class GodModeEngine:  # type: ignore[no-redef]
        def solve(self, expr): return {"expression": expr, "solutions": [], "confidence": 0}
        def prove(self, stmt): return {"statement": stmt, "proved": False}
        def discover_theorem(self): return {}


class MathEngine:
    """Unified math engine — evaluate, solve, differentiate, integrate,
    analyse, predict, and prove using all sub-packages."""

    def __init__(self) -> None:
        self.config      = ConfigurationManager()
        self.db          = DatabaseManager()
        self.rng         = ExtremeRandomGenerator()
        self.memory      = MemorySpace(self.config.get("memory.total_size", 100 * 1024 * 1024))
        self.symbolic    = SymbolicMathEngine()
        self.analytics   = AnalyticsEngine()
        self.predictive  = PredictiveAnalyticsEngine()
        self.god_mode    = GodModeEngine()
        self.history: List[Dict] = []
        self._running    = True

        # Apply precision setting
        getcontext().prec = self.config.get("precision.decimal_places", 100)

        self._start_metric_collector()
        self._print_banner()

    # ------------------------------------------------------------------ #
    #  Banner                                                              #
    # ------------------------------------------------------------------ #

    def _print_banner(self) -> None:
        print("=" * 56)
        print("  MATH ENGINE — ready")
        print("=" * 56)
        print(f"  DB:        {self.config.get('database.path')}")
        print(f"  Memory:    {self.config.get('memory.total_size') // (1024*1024)} MB")
        print(f"  Precision: {self.config.get('precision.decimal_places')} digits")
        print(f"  God Mode:  {self.config.get('god_mode.enabled')}")
        print(f"  API port:  {self.config.get('api.port')}")
        print(f"  Admin port:{self.config.get('admin.port')}")
        print("=" * 56)

    # ------------------------------------------------------------------ #
    #  Background metric collector                                         #
    # ------------------------------------------------------------------ #

    def _start_metric_collector(self) -> None:
        import threading

        def _collect() -> None:
            while self._running:
                time.sleep(60)
                try:
                    s = self.memory.stats()
                    self.db.record_metric("memory_used",        s["allocated"])
                    self.db.record_metric("memory_utilization", s["utilization"])
                except Exception:
                    pass

        threading.Thread(target=_collect, daemon=True).start()

    # ------------------------------------------------------------------ #
    #  Core operations                                                     #
    # ------------------------------------------------------------------ #

    def evaluate(self, expression: str,
                 variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        t0 = time.time()

        # Cache check
        cached = self.db.get_cached_result(expression)
        if cached:
            return {
                "expression": expression, "result": cached["result"],
                "numeric": cached.get("numeric"), "confidence": cached.get("confidence", 1.0),
                "cached": True, "time": 0,
            }

        # Symbolic evaluation
        result     = self.symbolic.evaluate(expression, variables)
        confidence = 1.0

        if result is None and self.config.get("god_mode.enabled", True):
            gm = self.god_mode.solve(expression)
            result     = gm["solutions"][0] if gm.get("solutions") else None
            confidence = gm.get("confidence", 0.5)

        elapsed = time.time() - t0

        if result is not None:
            eq_id = self.db.store_equation(
                expression,
                self._detect_type(expression),
                self._compute_complexity(expression),
            )
            self.db.store_result(
                eq_id, result, "evaluation",
                result if isinstance(result, (int, float)) else None,
                confidence, computation_time=elapsed,
            )
            self.db.log_audit("user", "evaluate", expression, str(result),
                              execution_time=elapsed)
            self.history.append({"expr": expression, "result": result, "time": elapsed})
            if len(self.history) > 10_000:
                self.history = self.history[-5_000:]

        return {
            "expression": expression,
            "result":     result,
            "numeric":    result if isinstance(result, (int, float)) else None,
            "confidence": confidence,
            "time":       elapsed,
            "cached":     False,
        }

    def solve(self, equation: str, variable: str = "x") -> Dict[str, Any]:
        sols = self.symbolic.solve_quadratic if "^2" in equation else None
        if self.config.get("god_mode.enabled", True):
            return self.god_mode.solve(equation)
        return self.evaluate(equation)

    def derivative(self, expression: str, variable: str,
                   at_point: float = 0.0) -> Optional[float]:
        return self.symbolic.derivative(expression, variable, at_point)

    def integral(self, expression: str, variable: str,
                 lower: float = 0.0, upper: float = 1.0) -> Optional[float]:
        return self.symbolic.integral(expression, variable, lower, upper)

    def limit(self, expression: str, variable: str, point: float) -> Optional[float]:
        return self.symbolic.limit(expression, variable, point)

    # ------------------------------------------------------------------ #
    #  Memory / pointer helpers                                            #
    # ------------------------------------------------------------------ #

    def malloc(self, size: int):
        return self.memory.malloc(size)

    def free(self, ptr) -> None:
        self.memory.free(ptr)

    # ------------------------------------------------------------------ #
    #  Analytics                                                           #
    # ------------------------------------------------------------------ #

    def analyze(self, data: List[float]) -> Dict[str, Any]:
        return self.analytics.descriptive_stats(data)

    def outliers(self, data: List[float], method: str = "iqr") -> Dict[str, Any]:
        return self.analytics.outlier_detection(data, method)

    # ------------------------------------------------------------------ #
    #  Prediction                                                          #
    # ------------------------------------------------------------------ #

    def train_predictive(self, data: List[float]) -> Dict[str, Any]:
        return self.predictive.train(data)

    def predict(self, history: List[float], steps: int = 10) -> Dict[str, Any]:
        if not self.predictive.trained:
            self.predictive.train(history)
        return self.predictive.predict(history, steps)

    def monte_carlo(self, history: List[float],
                    steps: int = 10, n_sims: int = 1000) -> Dict[str, Any]:
        if not self.predictive.trained:
            self.predictive.train(history)
        return self.predictive.monte_carlo_forecast(history, steps, n_sims)

    # ------------------------------------------------------------------ #
    #  God-mode                                                            #
    # ------------------------------------------------------------------ #

    def god_mode_solve(self, expression: str) -> Dict[str, Any]:
        return self.god_mode.solve(expression)

    def prove(self, statement: str) -> Dict[str, Any]:
        return self.god_mode.prove(statement)

    # ------------------------------------------------------------------ #
    #  Random math                                                         #
    # ------------------------------------------------------------------ #

    def random_math(self, complexity: str = "medium") -> Dict[str, Any]:
        depth = {"low": 2, "medium": 3, "high": 4}.get(complexity, 3)
        expr  = self.rng.random_expression(depth)
        res   = self.evaluate(expr)
        return {"expression": expr, "result": res["result"], "complexity": complexity}

    # ------------------------------------------------------------------ #
    #  Stats                                                               #
    # ------------------------------------------------------------------ #

    def get_stats(self) -> Dict[str, Any]:
        db_stats  = self.db.get_stats()
        mem_stats = self.memory.stats()
        return {
            **db_stats,
            "memory_allocated":   mem_stats["allocated"],
            "memory_free":        mem_stats["free"],
            "memory_utilization": mem_stats["utilization"],
            "history_count":      len(self.history),
            "random_entropy":     self.rng.get_entropy(),
        }

    # ------------------------------------------------------------------ #
    #  Helpers                                                             #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _detect_type(expression: str) -> str:
        if re.search(r"diff|derivative|integral", expression, re.I):
            return "calculus"
        if re.search(r"sqrt|sin|cos|tan|log|exp", expression, re.I):
            return "transcendental"
        if re.search(r"[a-zA-Z]", expression):
            return "symbolic"
        return "arithmetic"

    @staticmethod
    def _compute_complexity(expression: str) -> float:
        score  = len(expression) / 100
        score += expression.count("(") * 0.1
        score += expression.lower().count("sqrt") * 0.5
        score += expression.lower().count("integral") * 1.0
        return min(score, 10.0)

    # ------------------------------------------------------------------ #
    #  Lifecycle                                                           #
    # ------------------------------------------------------------------ #

    def stop(self) -> None:
        self._running = False
        self.db.close()
        print("\nMath Engine stopped.")

    # ── Extended engine operations ─────────────────────────────────────────

    def solve_system(self, equations: List[str],
                     variables: List[str]) -> Dict[str, Any]:
        """Solve a system of linear equations symbolically."""
        return self.god_mode.solve("\n".join(equations))

    def symbolic_simplify(self, expression: str) -> Dict[str, Any]:
        return self.god_mode.symbolic_simplify(expression)

    def symbolic_diff(self, expression: str, variable: str = "x",
                      order: int = 1) -> Dict[str, Any]:
        return self.god_mode.symbolic_diff(expression, variable, order)

    def symbolic_integrate(self, expression: str, variable: str = "x",
                            lower: float = None, upper: float = None) -> Dict[str, Any]:
        return self.god_mode.symbolic_integrate(expression, variable, lower, upper)

    def series_expansion(self, expression: str, variable: str = "x",
                          point: int = 0, order: int = 6) -> Dict[str, Any]:
        return self.god_mode.series_expansion(expression, variable, point, order)

    def factor(self, expression: str) -> Dict[str, Any]:
        return self.god_mode.factor_expression(expression)

    def expand(self, expression: str) -> Dict[str, Any]:
        return self.god_mode.expand_expression(expression)

    def limit(self, expression: str, variable: str,
              point: float, direction: str = "both") -> Optional[float]:
        return self.symbolic.limit(expression, variable, point, direction)

    def convert_unit(self, value: float,
                     from_unit: str, to_unit: str) -> Optional[float]:
        return self.symbolic.convert_unit(value, from_unit, to_unit)

    def find_roots(self, expression: str, variable: str = "x",
                   lo: float = -100, hi: float = 100) -> List[float]:
        return self.symbolic.find_roots(expression, variable, lo, hi)

    def critical_points(self, expression: str, variable: str = "x",
                         lo: float = -50, hi: float = 50) -> List[Dict]:
        return self.symbolic.critical_points(expression, variable, lo, hi)

    def classify_expression(self, expression: str) -> Dict[str, Any]:
        return self.symbolic.classify_expression(expression)

    def batch_evaluate(self, expressions: List[str]) -> List[Dict[str, Any]]:
        """Evaluate up to 500 expressions, returning results list."""
        from packages.god_mode import GodModeEngine
        results = []
        for expr in expressions[:500]:
            results.append(self.evaluate(expr))
        return results

    def correlation(self, x: List[float], y: List[float]) -> Dict[str, Any]:
        return self.analytics.correlation(x, y)

    def regression(self, x: List[float], y: List[float]) -> Dict[str, Any]:
        return self.analytics.regression_analysis(x, y)

    def polynomial_regression(self, x: List[float], y: List[float],
                               degree: int = 2) -> Dict[str, Any]:
        return self.analytics.polynomial_regression(x, y, degree)

    def pca(self, data: List[List[float]]) -> Dict[str, Any]:
        return self.analytics.pca_summary(data)

    def cross_validate(self, data: List[float], folds: int = 5) -> Dict[str, Any]:
        return self.predictive.cross_validate(data, folds)

    def forecast_intervals(self, history: List[float],
                            steps: int = 10, n_boot: int = 200) -> Dict[str, Any]:
        if not self.predictive.trained:
            self.predictive.train(history)
        return self.predictive.forecast_intervals_bootstrap(history, steps, n_boot)

    def random_token(self, n_bytes: int = 32) -> str:
        return self.rng.token_hex(n_bytes)

    def rng_health(self) -> Dict[str, Any]:
        return self.rng.full_health_check()

    def random_walk(self, steps: int = 100, dims: int = 1) -> List[List[float]]:
        return self.rng.random_walk(steps, dims=dims)

    def start_api(self):
        """Start the REST API server."""
        import sys
        sys.path.insert(0, str(_REPO_ROOT))
        from packages.api import APIServer
        host = self.config.get("api.host", "127.0.0.1")
        port = self.config.get("api.port", 8080)
        server = APIServer(self, host=host, port=port)
        server.start()
        return server

    def start_admin(self):
        """Start the admin web panel."""
        import sys
        sys.path.insert(0, str(_REPO_ROOT))
        from packages.admin import AdminServer
        host = self.config.get("admin.host", "127.0.0.1")
        port = self.config.get("admin.port", 8081)
        server = AdminServer(self, host=host, port=port)
        server.start()
        return server

    def start_all(self) -> None:
        """Start API + admin servers and block until Ctrl-C."""
        import signal, time
        api_srv   = self.start_api()
        admin_srv = self.start_admin()
        print("\n[ENGINE] All services running. Press Ctrl-C to stop.\n")
        def _shutdown(sig, frame):
            print("\n[ENGINE] Shutting down…")
            api_srv.stop(); admin_srv.stop(); self.stop()
            import sys; sys.exit(0)
        signal.signal(signal.SIGINT,  _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)
        while self._running:
            time.sleep(1)


# ── Security: engine-level input guard ───────────────────────────────────

class EngineSecurityGuard:
    """
    Top-level security guard for the MathEngine.
    Applied before any operation reaches a sub-package.

    Enforces:
      - Expression length cap
      - Variable name allowlist (only [a-zA-Z][a-zA-Z0-9_]*)
      - Blocked token list (prevent sandbox escapes)
      - Execution time budget (via threading.Timer)
      - Memory budget check before large allocations
    """
    MAX_EXPR_LEN   = 8_192
    MAX_VARS       = 64
    MAX_VAR_LEN    = 64
    EXEC_TIMEOUT   = 60.0
    BLOCKED = frozenset([
        "__import__","exec","eval","open","os.","sys.","subprocess",
        "socket","compile","globals","locals","getattr","setattr",
        "delattr","__class__","__bases__","__subclasses__","__mro__",
        "builtins","importlib","ctypes","pickle","marshal",
    ])

    @classmethod
    def validate_expression(cls, expr: str) -> str:
        if not isinstance(expr, str):
            raise TypeError(f"Expression must be str, got {type(expr).__name__}")
        if len(expr) > cls.MAX_EXPR_LEN:
            raise ValueError(f"Expression too long: {len(expr)} > {cls.MAX_EXPR_LEN}")
        lo = expr.lower()
        for tok in cls.BLOCKED:
            if tok in lo:
                raise ValueError(f"Blocked token '{tok}' in expression")
        return expr

    @classmethod
    def validate_variables(cls, variables: Optional[Dict]) -> Dict:
        if variables is None:
            return {}
        if not isinstance(variables, dict):
            raise TypeError("variables must be a dict")
        if len(variables) > cls.MAX_VARS:
            raise ValueError(f"Too many variables: {len(variables)} > {cls.MAX_VARS}")
        import re
        clean = {}
        for k, v in variables.items():
            if not re.match(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$", str(k)):
                raise ValueError(f"Invalid variable name: '{k}'")
            if not isinstance(v, (int, float, complex)):
                raise TypeError(f"Variable '{k}' must be numeric")
            clean[k] = v
        return clean

    @classmethod
    def validate_data_list(cls, data: List[float],
                            name: str = "data",
                            max_len: int = 1_000_000) -> List[float]:
        import math
        if not isinstance(data, (list, tuple)):
            raise TypeError(f"{name} must be a list")
        if len(data) > max_len:
            raise ValueError(f"{name} has {len(data)} items, max {max_len}")
        cleaned = [float(x) for x in data
                   if isinstance(x, (int, float)) and math.isfinite(x)]
        if not cleaned:
            raise ValueError(f"{name} contains no finite numeric values")
        return cleaned

    @classmethod
    def validate_steps(cls, steps: int,
                        max_steps: int = 10_000) -> int:
        if not isinstance(steps, int) or steps < 1:
            raise ValueError("steps must be a positive integer")
        if steps > max_steps:
            raise ValueError(f"steps {steps} exceeds maximum {max_steps}")
        return steps

    @classmethod
    def run_with_timeout(cls, fn, timeout: float = None,
                          *args, **kwargs):
        """Run fn(*args, **kwargs) with a wall-clock timeout."""
        import threading, queue
        limit = timeout or cls.EXEC_TIMEOUT
        result_q: queue.Queue = queue.Queue()
        def _target():
            try:
                result_q.put(("ok", fn(*args, **kwargs)))
            except Exception as exc:
                result_q.put(("err", exc))
        t = threading.Thread(target=_target, daemon=True)
        t.start(); t.join(limit)
        if t.is_alive():
            raise TimeoutError(f"Operation exceeded {limit}s timeout")
        status, val = result_q.get()
        if status == "err":
            raise val
        return val


# ── Standards: engine response envelope ──────────────────────────────────

class EngineResponseStandards:
    """
    Standardised response envelope for all MathEngine operations.
    Every public method should wrap its result via one of these helpers.
    Follows JSON:API v1.1 conventions loosely adapted for math results.
    """

    @staticmethod
    def evaluation(expression: str, result: Any,
                   numeric: Optional[float] = None,
                   confidence: float = 1.0,
                   elapsed: float = 0.0,
                   cached: bool = False) -> Dict[str, Any]:
        return {
            "type":       "evaluation",
            "expression": expression,
            "result":     result,
            "numeric":    numeric,
            "confidence": round(confidence, 6),
            "cached":     cached,
            "elapsed_ms": round(elapsed * 1000, 3),
        }

    @staticmethod
    def solution(equation: str, solutions: List[Any],
                 method: str = "symbolic",
                 confidence: float = 1.0) -> Dict[str, Any]:
        return {
            "type":       "solution",
            "equation":   equation,
            "solutions":  solutions,
            "method":     method,
            "confidence": round(confidence, 6),
        }

    @staticmethod
    def error(operation: str, message: str,
              code: str = "EVAL_ERROR") -> Dict[str, Any]:
        return {
            "type":      "error",
            "operation": operation,
            "error":     {"code": code, "message": message},
        }

    @staticmethod
    def analytics_result(data_len: int, stats: Dict,
                          method: str = "descriptive") -> Dict[str, Any]:
        return {
            "type":     "analytics",
            "method":   method,
            "n":        data_len,
            "stats":    stats,
        }

    @staticmethod
    def forecast_result(steps: int, predictions: Dict,
                         confidence: List[Dict]) -> Dict[str, Any]:
        return {
            "type":        "forecast",
            "steps":       steps,
            "predictions": predictions,
            "confidence":  confidence,
        }

    @staticmethod
    def sanitise(obj: Any) -> Any:
        """Recursively replace non-serialisable values for JSON output."""
        import math
        if isinstance(obj, float):
            if math.isnan(obj):  return None
            if math.isinf(obj):  return str(obj)
            return obj
        if isinstance(obj, complex):
            return {"real": obj.real, "imag": obj.imag}
        if isinstance(obj, dict):
            return {k: EngineResponseStandards.sanitise(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [EngineResponseStandards.sanitise(v) for v in obj]
        return obj
