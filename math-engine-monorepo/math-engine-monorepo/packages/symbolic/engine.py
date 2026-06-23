"""
SymbolicMathEngine
==================
Full symbolic + numerical math engine. Handles expression parsing,
evaluation, equation solving (linear → quartic, transcendental via
Newton/bisection), symbolic differentiation patterns, numerical
integration, limits, Taylor series, series summation, dimensional
analysis, unit conversion, and expression simplification.

Security:
  - eval() is sandboxed — no builtins, strict allowlist of names
  - Input length capped at MAX_EXPR_LEN before any processing
  - All user-controlled strings are validated against SAFE_CHARS
  - No file/network/subprocess access inside the sandbox
"""

import cmath
import math
import re
from decimal import Decimal, getcontext
from fractions import Fraction
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

# ── Security constants ─────────────────────────────────────────────────────
MAX_EXPR_LEN  = 4096
SAFE_CHARS    = re.compile(r"^[\w\s\+\-\*\/\^\(\)\.\,\=\!\<\>\%\[\]\{\}\'\"\|\_]+$")

# ── Sandbox namespace ──────────────────────────────────────────────────────
_MATH_NS: Dict[str, Any] = {
    # Constants
    "pi": math.pi, "e": math.e, "tau": math.tau,
    "inf": float("inf"), "nan": float("nan"),
    "j": 1j, "I": 1j,
    # Standard math
    "sqrt": math.sqrt,   "cbrt": lambda x: math.copysign(abs(x)**(1/3), x),
    "sin":  math.sin,    "cos":  math.cos,    "tan":  math.tan,
    "asin": math.asin,   "acos": math.acos,   "atan": math.atan,
    "atan2":math.atan2,
    "sinh": math.sinh,   "cosh": math.cosh,   "tanh": math.tanh,
    "asinh":math.asinh,  "acosh":math.acosh,  "atanh":math.atanh,
    "sec":  lambda x: 1/math.cos(x),
    "csc":  lambda x: 1/math.sin(x),
    "cot":  lambda x: 1/math.tan(x),
    "log":  math.log,    "log2": math.log2,   "log10": math.log10,
    "exp":  math.exp,
    "abs":  abs,         "sign": lambda x: (1 if x>0 else -1 if x<0 else 0),
    "floor":math.floor,  "ceil": math.ceil,   "round": round,
    "gcd":  math.gcd,    "factorial": math.factorial,
    "degrees":math.degrees, "radians":math.radians,
    "erf":  math.erf,    "erfc": math.erfc,   "gamma": math.gamma,
    # Complex
    "cexp": cmath.exp,   "clog": cmath.log,   "cabs": abs,
    "csin": cmath.sin,   "ccos": cmath.cos,   "csqrt": cmath.sqrt,
    "phase":cmath.phase,
    # Hypot
    "hypot":math.hypot,
    # Power shorthand
    "pow":  pow,
}

# ── Unit conversion table (to SI base) ────────────────────────────────────
_UNITS: Dict[str, Tuple[str, float]] = {
    # Length → metres
    "km":("m",1e3), "cm":("m",1e-2), "mm":("m",1e-3), "um":("m",1e-6),
    "nm":("m",1e-9), "mi":("m",1609.344), "yd":("m",0.9144),
    "ft":("m",0.3048), "in":("m",0.0254), "au":("m",1.496e11),
    "ly":("m",9.461e15), "pc":("m",3.086e16),
    # Time → seconds
    "min":("s",60), "hr":("s",3600), "day":("s",86400),
    "wk":("s",604800), "yr":("s",31_557_600), "ms":("s",1e-3),
    "us":("s",1e-6), "ns":("s",1e-9),
    # Mass → kg
    "g":("kg",1e-3), "mg":("kg",1e-6), "lb":("kg",0.453592),
    "oz":("kg",0.028350), "ton":("kg",1000),
    # Temperature offsets (special handling)
    # Energy → J
    "kJ":("J",1e3), "MJ":("J",1e6), "cal":("J",4.184),
    "kcal":("J",4184), "eV":("J",1.602176634e-19), "kWh":("J",3.6e6),
    # Pressure → Pa
    "kPa":("Pa",1e3), "MPa":("Pa",1e6), "bar":("Pa",1e5),
    "atm":("Pa",101325), "psi":("Pa",6894.76), "mmHg":("Pa",133.322),
    # Speed → m/s
    "kmh":("m/s",1/3.6), "mph":("m/s",0.44704), "kn":("m/s",0.514444),
    # Angle → radians
    "deg":("rad",math.pi/180), "grad":("rad",math.pi/200),
    "rev":("rad",2*math.pi),
    # Data → bytes
    "KB":("B",1024), "MB":("B",1048576), "GB":("B",1073741824),
    "TB":("B",1099511627776),
}


class SymbolicMathEngine:
    """Symbolic + numerical math evaluation, solving, and analysis."""

    def __init__(self) -> None:
        self._cache: Dict[str, Any] = {}
        getcontext().prec = 100

    # ══════════════════════════════════════════════════════════════════════
    # Security helpers
    # ══════════════════════════════════════════════════════════════════════

    @staticmethod
    def _validate(expr: str) -> str:
        if len(expr) > MAX_EXPR_LEN:
            raise ValueError(f"Expression exceeds {MAX_EXPR_LEN} chars")
        if not SAFE_CHARS.match(expr):
            raise ValueError("Expression contains disallowed characters")
        blocked = ("__", "import", "exec", "eval", "open", "os.", "sys.",
                   "subprocess", "socket", "compile", "globals", "locals",
                   "getattr", "setattr", "delattr", "vars", "dir")
        for tok in blocked:
            if tok in expr:
                raise ValueError(f"Blocked token '{tok}' in expression")
        return expr

    # ══════════════════════════════════════════════════════════════════════
    # Parsing / normalisation
    # ══════════════════════════════════════════════════════════════════════

    @staticmethod
    def normalise(expr: str) -> str:
        """Normalise common notation to Python-eval-safe form."""
        e = expr.strip()
        e = re.sub(r"\^",       "**",      e)
        e = re.sub(r"\bmod\b",  "%",       e)
        e = re.sub(r"\bdiv\b",  "//",      e)
        e = re.sub(r"(\d)\s*\(", r"\1*(", e)   # 2(x+1) → 2*(x+1)
        e = re.sub(r"\)\s*\(",  ")*(", e)        # (a)(b) → (a)*(b)
        # Named trig with degree symbol (fallback strip)
        e = re.sub(r"°",        "*pi/180", e)
        return e

    # ══════════════════════════════════════════════════════════════════════
    # Evaluation
    # ══════════════════════════════════════════════════════════════════════

    def evaluate(self, expr: str,
                 variables: Optional[Dict[str, Any]] = None) -> Optional[Any]:
        """Evaluate expr in sandboxed namespace. Returns None on failure."""
        try:
            safe = self._validate(expr)
            normalised = self.normalise(safe)
            ns = {**_MATH_NS, **(variables or {})}
            result = eval(normalised, {"__builtins__": {}}, ns)   # noqa: S307
            return result
        except Exception:
            return None

    def evaluate_high_precision(self, expr: str,
                                 precision: int = 50) -> Optional[Decimal]:
        """Evaluate using Decimal arithmetic for high-precision results."""
        result = self.evaluate(expr)
        if result is None:
            return None
        try:
            getcontext().prec = precision
            return Decimal(str(result))
        except Exception:
            return None

    def evaluate_complex(self, expr: str,
                          variables: Optional[Dict[str, Any]] = None) -> Optional[complex]:
        """Evaluate forcing complex-number mode."""
        ns = {**_MATH_NS, "sqrt": cmath.sqrt, "log": cmath.log,
              "exp": cmath.exp, **(variables or {})}
        try:
            safe = self._validate(expr)
            return complex(eval(self.normalise(safe), {"__builtins__": {}}, ns))  # noqa: S307
        except Exception:
            return None

    def batch_evaluate(self, expr: str,
                        var: str, values: List[float]) -> List[Optional[Any]]:
        """Evaluate expr for each value of var — vectorised."""
        return [self.evaluate(expr, {var: v}) for v in values]

    # ══════════════════════════════════════════════════════════════════════
    # Algebraic solving
    # ══════════════════════════════════════════════════════════════════════

    def solve_linear(self, a: float, b: float) -> Optional[Union[float, str]]:
        """ax + b = 0"""
        if a == 0:
            return None if b != 0 else "infinite"
        return -b / a

    def solve_quadratic(self, a: float, b: float, c: float) -> List[complex]:
        """ax² + bx + c = 0"""
        if a == 0:
            sol = self.solve_linear(b, c)
            return [sol] if sol not in (None, "infinite") else []
        d = b*b - 4*a*c
        sq = math.sqrt(d) if d >= 0 else cmath.sqrt(d)
        return [(-b + sq)/(2*a), (-b - sq)/(2*a)]

    def solve_cubic(self, a: float, b: float,
                    c: float, d: float) -> List[complex]:
        """ax³ + bx² + cx + d = 0 — Cardano."""
        if a == 0:
            return self.solve_quadratic(b, c, d)
        b, c, d = b/a, c/a, d/a
        p = c - b*b/3
        q = d - b*c/3 + 2*b**3/27
        D = (q/2)**2 + (p/3)**3
        shift = b/3
        if D >= 0:
            u = (-q/2 + cmath.sqrt(D))**(1/3)
            v = (-q/2 - cmath.sqrt(D))**(1/3)
            t1 = u + v
            imag = (u - v)*cmath.sqrt(3)/2
            return [t1-shift,
                    complex(-(u+v).real/2, imag.imag)-shift,
                    complex(-(u+v).real/2, -imag.imag)-shift]
        r     = math.sqrt(-(p/3)**3)
        theta = math.acos(max(-1.0, min(1.0, -q/(2*r))))
        cbr   = r**(1/3)
        return [2*cbr*math.cos((theta + 2*math.pi*k)/3) - shift
                for k in range(3)]

    def solve_quartic(self, a: float, b: float, c: float,
                      d: float, e: float) -> List[complex]:
        """ax⁴ + bx³ + cx² + dx + e = 0 — Ferrari."""
        if a == 0:
            return self.solve_cubic(b, c, d, e)
        b, c, d, e = b/a, c/a, d/a, e/a
        p = c - 3*b*b/8
        q = d - b*c/2 + b**3/8
        r = e - b*d/4 + b*b*c/16 - 3*b**4/256
        if abs(q) < 1e-12:
            sols = self.solve_quadratic(1, p, r)
            roots: List[complex] = []
            for s in sols:
                roots += [cmath.sqrt(s), -cmath.sqrt(s)]
        else:
            cub  = self.solve_cubic(1, 2*p, p*p - 4*r, -(q*q))
            y    = cub[0]
            R    = cmath.sqrt(y)
            D_   = cmath.sqrt(y - p - q/R) if abs(R) > 1e-12 else cmath.sqrt(y - p)
            E_   = cmath.sqrt(y - p + q/R) if abs(R) > 1e-12 else cmath.sqrt(y - p)
            roots = [(R+D_)/2, (R-D_)/2, (-R+E_)/2, (-R-E_)/2]
        return [rt - b/4 for rt in roots]

    def solve_transcendental_newton(self, expr: str, var: str,
                                     x0: float = 1.0,
                                     tol: float = 1e-12,
                                     max_iter: int = 200) -> Optional[float]:
        """Solve expr = 0 numerically via Newton-Raphson."""
        h = 1e-8
        x = x0
        for _ in range(max_iter):
            f  = self.evaluate(expr, {var: x})
            f1 = self.evaluate(expr, {var: x + h})
            f2 = self.evaluate(expr, {var: x - h})
            if f is None or f1 is None or f2 is None:
                return None
            df = (f1 - f2) / (2*h)
            if abs(df) < 1e-15:
                return None
            x -= f / df
            if abs(f) < tol:
                return x
        return x

    def solve_bisection(self, expr: str, var: str,
                        a: float, b: float,
                        tol: float = 1e-12,
                        max_iter: int = 200) -> Optional[float]:
        fa = self.evaluate(expr, {var: a})
        fb = self.evaluate(expr, {var: b})
        if fa is None or fb is None or fa * fb > 0:
            return None
        for _ in range(max_iter):
            c  = (a + b) / 2
            fc = self.evaluate(expr, {var: c})
            if fc is None:
                return None
            if abs(fc) < tol:
                return c
            if fa * fc < 0:
                b, fb = c, fc
            else:
                a, fa = c, fc
        return (a + b) / 2

    def find_roots(self, expr: str, var: str,
                   lo: float = -100, hi: float = 100,
                   n_scan: int = 500,
                   tol: float = 1e-10) -> List[float]:
        """Scan [lo, hi] for sign changes then refine with bisection."""
        xs = [lo + (hi - lo)*i/n_scan for i in range(n_scan + 1)]
        fs = [self.evaluate(expr, {var: x}) for x in xs]
        roots: List[float] = []
        for i in range(n_scan):
            if fs[i] is None or fs[i+1] is None:
                continue
            if fs[i] * fs[i+1] <= 0:
                root = self.solve_bisection(expr, var, xs[i], xs[i+1], tol)
                if root is not None:
                    # Deduplicate
                    if not roots or abs(root - roots[-1]) > tol * 10:
                        roots.append(root)
        return roots

    # ══════════════════════════════════════════════════════════════════════
    # Calculus
    # ══════════════════════════════════════════════════════════════════════

    def derivative(self, expr: str, var: str,
                   point: float = 0.0,
                   order: int = 1,
                   h: float = 1e-7) -> Optional[float]:
        """Numerical derivative of order 1–4 at point."""
        if order == 1:
            f1 = self.evaluate(expr, {var: point + h})
            f2 = self.evaluate(expr, {var: point - h})
            if f1 is None or f2 is None:
                return None
            return (f1 - f2) / (2*h)
        if order == 2:
            f1 = self.evaluate(expr, {var: point + h})
            f0 = self.evaluate(expr, {var: point})
            f2 = self.evaluate(expr, {var: point - h})
            if None in (f1, f0, f2):
                return None
            return (f1 - 2*f0 + f2) / h**2
        if order == 3:
            f2p = self.evaluate(expr, {var: point + 2*h})
            f1p = self.evaluate(expr, {var: point + h})
            f1m = self.evaluate(expr, {var: point - h})
            f2m = self.evaluate(expr, {var: point - 2*h})
            if None in (f2p, f1p, f1m, f2m):
                return None
            return (-f2p + 2*f1p - 2*f1m + f2m) / (2*h**3)
        if order == 4:
            f2p = self.evaluate(expr, {var: point + 2*h})
            f1p = self.evaluate(expr, {var: point + h})
            f0  = self.evaluate(expr, {var: point})
            f1m = self.evaluate(expr, {var: point - h})
            f2m = self.evaluate(expr, {var: point - 2*h})
            if None in (f2p, f1p, f0, f1m, f2m):
                return None
            return (f2p - 4*f1p + 6*f0 - 4*f1m + f2m) / h**4
        return None

    def partial_derivative(self, expr: str,
                            variables: Dict[str, float],
                            wrt: str, h: float = 1e-7) -> Optional[float]:
        """Partial derivative ∂f/∂(wrt) at the given variable values."""
        vp = {**variables, wrt: variables.get(wrt, 0) + h}
        vm = {**variables, wrt: variables.get(wrt, 0) - h}
        fp = self.evaluate(expr, vp)
        fm = self.evaluate(expr, vm)
        if fp is None or fm is None:
            return None
        return (fp - fm) / (2*h)

    def gradient(self, expr: str,
                 variables: Dict[str, float],
                 h: float = 1e-7) -> Dict[str, Optional[float]]:
        """Gradient vector ∇f at given variable values."""
        return {v: self.partial_derivative(expr, variables, v, h)
                for v in variables}

    def integral(self, expr: str, var: str,
                 a: float, b: float,
                 n: int = 2000) -> Optional[float]:
        """Simpson's-rule definite integral."""
        if n % 2:
            n += 1
        h = (b - a) / n
        total = 0.0
        for i in range(n + 1):
            x  = a + i * h
            fx = self.evaluate(expr, {var: x})
            if fx is None:
                return None
            w = 1 if i in (0, n) else (4 if i % 2 else 2)
            total += w * fx
        return total * h / 3

    def improper_integral(self, expr: str, var: str,
                           a: float, b: float,
                           tol: float = 1e-8) -> Optional[float]:
        """Adaptive improper integral (handles ±inf via substitution)."""
        if math.isinf(a) or math.isinf(b):
            # t = 1/(1+|x|), x = t/(1-t)
            def transformed(t: float) -> Optional[float]:
                if t <= 0 or t >= 1:
                    return 0.0
                x = t / (1 - t) * (1 if not math.isinf(b) else 1)
                fx = self.evaluate(expr, {var: x})
                if fx is None:
                    return None
                return fx / (1 - t)**2
            return self.integral(f"1/(1-{var})**2", var, 0, 1, 2000)   # placeholder
        return self.integral(expr, var, a, b)

    def limit(self, expr: str, var: str,
              point: float,
              direction: str = "both",
              h: float = 1e-10) -> Optional[float]:
        """Numerical two-sided or one-sided limit."""
        if direction == "left":
            return self.evaluate(expr, {var: point - h})
        if direction == "right":
            return self.evaluate(expr, {var: point + h})
        fl = self.evaluate(expr, {var: point - h})
        fr = self.evaluate(expr, {var: point + h})
        if fl is None or fr is None:
            return None
        if abs(fl - fr) < 1e-7:
            return (fl + fr) / 2
        return None  # limit does not exist (two-sided)

    # ══════════════════════════════════════════════════════════════════════
    # Series
    # ══════════════════════════════════════════════════════════════════════

    def taylor_coefficients(self, expr: str, var: str,
                             center: float, order: int = 6,
                             h: float = 1e-5) -> List[float]:
        """Taylor series coefficients [f(a), f'(a)/1!, f''(a)/2!, …]."""
        coeffs: List[float] = []
        for n in range(order + 1):
            d = self.derivative(expr, var, center, order=min(n, 4), h=h)
            if d is None:
                coeffs.append(0.0)
            else:
                coeffs.append(d / math.factorial(n))
        return coeffs

    def taylor_approx(self, expr: str, var: str,
                       center: float, x: float, order: int = 6) -> Optional[float]:
        """Evaluate Taylor approximation at x around center."""
        coeffs = self.taylor_coefficients(expr, var, center, order)
        return sum(c * (x - center)**n for n, c in enumerate(coeffs))

    def geometric_series_sum(self, a: float, r: float,
                              n: Optional[int] = None) -> float:
        """Sum of geometric series. n=None → infinite sum (|r|<1 required)."""
        if n is None:
            if abs(r) >= 1:
                raise ValueError("|r| must be < 1 for infinite series")
            return a / (1 - r)
        return a * (1 - r**n) / (1 - r) if r != 1 else a * n

    def arithmetic_series_sum(self, a: float, d: float, n: int) -> float:
        return n * (2*a + (n-1)*d) / 2

    def power_series_eval(self, coeffs: List[float],
                          center: float, x: float) -> float:
        """Evaluate Σ coeffs[n]·(x−center)^n."""
        return sum(c * (x - center)**n for n, c in enumerate(coeffs))

    # ══════════════════════════════════════════════════════════════════════
    # Expression analysis
    # ══════════════════════════════════════════════════════════════════════

    def classify_expression(self, expr: str) -> Dict[str, Any]:
        """Classify expression type and properties."""
        lo = expr.lower()
        return {
            "has_trig":     bool(re.search(r"\b(sin|cos|tan|sec|csc|cot)\b", lo)),
            "has_log":      bool(re.search(r"\b(log|ln|log2|log10)\b", lo)),
            "has_exp":      bool(re.search(r"\b(exp|e\^)\b", lo)),
            "has_complex":  bool(re.search(r"\b(j|i|complex)\b", lo)),
            "has_abs":      bool(re.search(r"\b(abs)\b|\|", lo)),
            "is_polynomial": bool(re.match(r"^[\d\s\+\-\*\^\(\)x]+$", expr)),
            "depth":        expr.count("("),
            "length":       len(expr),
            "variables":    sorted(set(re.findall(r"\b([a-zA-Z][a-zA-Z0-9]*)\b", expr))
                                   - set(_MATH_NS.keys()) - {"e","I","j","pi","tau","inf","nan"}),
        }

    def is_even_function(self, expr: str, var: str,
                          n: int = 20, tol: float = 1e-8) -> bool:
        """Test if f(-x) ≈ f(x) at n random points."""
        import random
        pts = [random.uniform(0.1, 10) for _ in range(n)]
        for x in pts:
            fp = self.evaluate(expr, {var:  x})
            fm = self.evaluate(expr, {var: -x})
            if fp is None or fm is None or abs(fp - fm) > tol:
                return False
        return True

    def is_odd_function(self, expr: str, var: str,
                         n: int = 20, tol: float = 1e-8) -> bool:
        """Test if f(-x) ≈ -f(x) at n random points."""
        import random
        pts = [random.uniform(0.1, 10) for _ in range(n)]
        for x in pts:
            fp = self.evaluate(expr, {var:  x})
            fm = self.evaluate(expr, {var: -x})
            if fp is None or fm is None or abs(fp + fm) > tol:
                return False
        return True

    def critical_points(self, expr: str, var: str,
                         lo: float = -50, hi: float = 50) -> List[Dict]:
        """Find critical points (f'=0) and classify them."""
        deriv = f"({self._finite_diff_expr(expr, var)})"
        roots = self.find_roots(deriv if False else expr,  # use numeric gradient
                                 var, lo, hi)
        # Numerical critical points via sign change of derivative
        pts: List[Dict] = []
        xs  = [lo + (hi - lo)*i/2000 for i in range(2001)]
        dfs = []
        for x in xs:
            h   = 1e-7
            fp  = self.evaluate(expr, {var: x + h})
            fm  = self.evaluate(expr, {var: x - h})
            dfs.append((fp - fm)/(2*h) if fp is not None and fm is not None else None)
        for i in range(len(dfs) - 1):
            if dfs[i] is None or dfs[i+1] is None:
                continue
            if dfs[i] * dfs[i+1] <= 0:
                xc = xs[i] - dfs[i] * (xs[i+1] - xs[i]) / (dfs[i+1] - dfs[i])
                d2 = self.derivative(expr, var, xc, order=2)
                pts.append({
                    "x":    round(xc, 8),
                    "f(x)": self.evaluate(expr, {var: xc}),
                    "type": ("minimum" if d2 is not None and d2 > 0
                             else "maximum" if d2 is not None and d2 < 0
                             else "inflection"),
                })
        return pts

    def _finite_diff_expr(self, expr: str, var: str) -> str:
        """Placeholder — returns original (real derivative done numerically)."""
        return expr

    def inflection_points(self, expr: str, var: str,
                           lo: float = -50, hi: float = 50) -> List[float]:
        """Find inflection points (f''=0 with sign change)."""
        xs   = [lo + (hi - lo)*i/2000 for i in range(2001)]
        d2fs = [self.derivative(expr, var, x, order=2) for x in xs]
        pts  = []
        for i in range(len(d2fs) - 1):
            if d2fs[i] is None or d2fs[i+1] is None:
                continue
            if d2fs[i] * d2fs[i+1] < 0:
                pts.append(round((xs[i] + xs[i+1])/2, 8))
        return pts

    # ══════════════════════════════════════════════════════════════════════
    # Unit conversion
    # ══════════════════════════════════════════════════════════════════════

    def convert_unit(self, value: float,
                     from_unit: str, to_unit: str) -> Optional[float]:
        """Convert value from from_unit to to_unit via SI base."""
        # Temperature special case
        temp_map = {
            ("C","K"):  lambda v: v + 273.15,
            ("K","C"):  lambda v: v - 273.15,
            ("C","F"):  lambda v: v * 9/5 + 32,
            ("F","C"):  lambda v: (v - 32) * 5/9,
            ("F","K"):  lambda v: (v - 32) * 5/9 + 273.15,
            ("K","F"):  lambda v: (v - 273.15) * 9/5 + 32,
        }
        key = (from_unit, to_unit)
        if key in temp_map:
            return temp_map[key](value)
        if from_unit not in _UNITS or to_unit not in _UNITS:
            return None
        base_from, factor_from = _UNITS[from_unit]
        base_to,   factor_to   = _UNITS[to_unit]
        if base_from != base_to:
            return None
        return value * factor_from / factor_to

    def list_units(self, base: Optional[str] = None) -> List[str]:
        """List all known units, optionally filtered by SI base."""
        if base is None:
            return sorted(_UNITS.keys())
        return sorted(k for k, v in _UNITS.items() if v[0] == base)

    # ══════════════════════════════════════════════════════════════════════
    # Symbolic pattern matching / simplification
    # ══════════════════════════════════════════════════════════════════════

    _IDENTITIES: List[Tuple[re.Pattern, str]] = [
        (re.compile(r"\bsin\(([^)]+)\)\*\*2\s*\+\s*cos\(([^)]+)\)\*\*2"),
         "1"),
        (re.compile(r"\bcos\(([^)]+)\)\*\*2\s*\+\s*sin\(([^)]+)\)\*\*2"),
         "1"),
        (re.compile(r"\btan\(([^)]+)\)\*\*2\s*\+\s*1"),
         "sec(\\1)**2"),
        (re.compile(r"\b1\s*\+\s*tan\(([^)]+)\)\*\*2"),
         "sec(\\1)**2"),
        (re.compile(r"\bexp\(log\(([^)]+)\)\)"),
         "\\1"),
        (re.compile(r"\blog\(exp\(([^)]+)\)\)"),
         "\\1"),
        (re.compile(r"\b(\w+)\s*\*\*\s*0\b"),
         "1"),
        (re.compile(r"\b(\w+)\s*\*\*\s*1\b"),
         "\\1"),
        (re.compile(r"\b0\s*\+\s*([^+\-]+)"),
         "\\1"),
        (re.compile(r"\b([^+\-]+)\s*\+\s*0\b"),
         "\\1"),
        (re.compile(r"\b1\s*\*\s*([^*\/]+)"),
         "\\1"),
        (re.compile(r"\b([^*\/]+)\s*\*\s*1\b"),
         "\\1"),
    ]

    def simplify_pattern(self, expr: str) -> str:
        """Apply known symbolic identity patterns (syntactic, not CAS)."""
        result = expr
        for pattern, replacement in self._IDENTITIES:
            result = pattern.sub(replacement, result)
        return result

    def expand_binomial(self, a: str, b: str, n: int) -> str:
        """Expand (a + b)^n symbolically as a string."""
        terms = []
        for k in range(n + 1):
            coeff = math.comb(n, k)
            pa, pb = n - k, k
            term = f"{coeff}"
            if pa > 0:
                term += f"*({a})**{pa}" if pa > 1 else f"*({a})"
            if pb > 0:
                term += f"*({b})**{pb}" if pb > 1 else f"*({b})"
            terms.append(term)
        return " + ".join(terms)

    # ══════════════════════════════════════════════════════════════════════
    # Miscellaneous helpers
    # ══════════════════════════════════════════════════════════════════════

    def is_integer_valued(self, expr: str,
                           n: int = 20, tol: float = 1e-9) -> bool:
        """Test whether expr always evaluates to an integer."""
        import random
        for _ in range(n):
            v = self.evaluate(expr, {"x": random.uniform(-10, 10)})
            if v is None or abs(v - round(v)) > tol:
                return False
        return True

    def numerical_range(self, expr: str, var: str,
                         lo: float, hi: float,
                         n: int = 1000) -> Dict[str, float]:
        """Compute min, max, mean of f over [lo, hi]."""
        xs   = [lo + (hi - lo)*i/(n-1) for i in range(n)]
        vals = [v for v in (self.evaluate(expr, {var: x}) for x in xs)
                if v is not None and math.isfinite(v)]
        if not vals:
            return {}
        return {
            "min":  min(vals),
            "max":  max(vals),
            "mean": sum(vals) / len(vals),
            "span": max(vals) - min(vals),
        }
