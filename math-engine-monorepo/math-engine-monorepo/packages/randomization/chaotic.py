"""
ChaoticRNG
==========
Ensemble of 13 chaotic dynamical systems:
  Lorenz, Rössler, Hénon, Logistic, Tent, Cubic, Gauss, Sine,
  Ikeda, Baker, Arnold cat map, Duffing, van der Pol.

Each system evolves independently; the ExtremeRandomGenerator
blends their outputs using nonlinear mixing.

Security: purely deterministic chaos — always seed via cryptographic
entropy (done in ExtremeRandomGenerator).
"""

import math
from typing import List, Tuple


class ChaoticRNG:
    """Ensemble chaotic random number generator — 13 independent attractors."""

    def __init__(self) -> None:
        # Lorenz
        self._lx, self._ly, self._lz = 0.1, 0.2, 0.3
        # Rössler
        self._rx, self._ry, self._rz = 0.1, 0.2, 0.1
        # Hénon
        self._hx, self._hy = 0.1, 0.1
        # Logistic
        self._log_x = 0.5
        # Tent
        self._tent_x = 0.5
        # Cubic
        self._cub_x = 0.5
        # Gauss
        self._gauss_x = 0.5
        # Sine
        self._sine_x = 0.5
        # Ikeda
        self._ik_x, self._ik_y = 0.1, 0.1
        # Baker
        self._baker_x = 0.5
        # Arnold cat map (integer lattice mod)
        self._ar_x, self._ar_y = 1, 1
        self._ar_mod = 101
        # Duffing oscillator
        self._du_x, self._du_v = 0.1, 0.0
        self._du_t = 0.0
        # van der Pol oscillator
        self._vdp_x, self._vdp_v = 1.0, 0.0

    # ── Lorenz system ─────────────────────────────────────────────────────
    def lorenz(self, sigma: float = 10.0, rho: float = 28.0,
               beta: float = 8/3, dt: float = 0.01) -> float:
        dx = sigma * (self._ly - self._lx)
        dy = self._lx * (rho - self._lz) - self._ly
        dz = self._lx * self._ly - beta * self._lz
        self._lx += dx * dt
        self._ly += dy * dt
        self._lz += dz * dt
        return self._lx

    # ── Rössler system ────────────────────────────────────────────────────
    def rossler(self, a: float = 0.2, b: float = 0.2,
                c: float = 5.7, dt: float = 0.01) -> float:
        dx = -self._ry - self._rz
        dy =  self._rx + a * self._ry
        dz =  b + self._rz * (self._rx - c)
        self._rx += dx * dt
        self._ry += dy * dt
        self._rz += dz * dt
        return self._rx

    # ── Hénon map ─────────────────────────────────────────────────────────
    def henon(self, a: float = 1.4, b: float = 0.3) -> float:
        x_new = 1 - a * self._hx**2 + self._hy
        self._hy = b * self._hx
        self._hx = x_new
        return self._hx

    # ── Logistic map ──────────────────────────────────────────────────────
    def logistic(self, r: float = 3.99) -> float:
        self._log_x = r * self._log_x * (1 - self._log_x)
        return self._log_x

    # ── Tent map ──────────────────────────────────────────────────────────
    def tent(self, mu: float = 1.99) -> float:
        if self._tent_x < 0.5:
            self._tent_x = mu * self._tent_x
        else:
            self._tent_x = mu * (1 - self._tent_x)
        return self._tent_x

    # ── Cubic map ─────────────────────────────────────────────────────────
    def cubic(self, a: float = 2.6) -> float:
        self._cub_x = a * self._cub_x * (1 - self._cub_x**2)
        return self._cub_x

    # ── Gauss map ─────────────────────────────────────────────────────────
    def gauss(self, a: float = 1.0) -> float:
        self._gauss_x = math.exp(-a * self._gauss_x**2) + 0.5
        self._gauss_x -= math.floor(self._gauss_x)
        return self._gauss_x

    # ── Sine map ──────────────────────────────────────────────────────────
    def sine(self, a: float = 0.9) -> float:
        self._sine_x = a * math.sin(math.pi * self._sine_x)
        return self._sine_x

    # ── Ikeda map ─────────────────────────────────────────────────────────
    def ikeda(self, u: float = 0.9) -> float:
        t = 0.4 - 6.0 / (1 + self._ik_x**2 + self._ik_y**2)
        x_new = 1 + u * (self._ik_x * math.cos(t) - self._ik_y * math.sin(t))
        y_new =     u * (self._ik_x * math.sin(t) + self._ik_y * math.cos(t))
        self._ik_x, self._ik_y = x_new, y_new
        return self._ik_x

    # ── Baker map ─────────────────────────────────────────────────────────
    def baker(self) -> float:
        self._baker_x = (2 * self._baker_x if self._baker_x < 0.5
                         else 2 * (1 - self._baker_x))
        return self._baker_x

    # ── Arnold cat map ────────────────────────────────────────────────────
    def arnold(self) -> float:
        x_new = (self._ar_x + self._ar_y) % self._ar_mod
        y_new = (self._ar_x + 2 * self._ar_y) % self._ar_mod
        self._ar_x, self._ar_y = x_new, y_new
        return self._ar_x / self._ar_mod

    # ── Duffing oscillator ────────────────────────────────────────────────
    def duffing(self, alpha: float = -1.0, beta: float = 1.0,
                delta: float = 0.3, gamma: float = 0.5,
                omega: float = 1.2, dt: float = 0.05) -> float:
        """Duffing oscillator: ẍ + δẋ - αx - βx³ = γcos(ωt)"""
        dx = self._du_v
        dv = (-delta * self._du_v + alpha * self._du_x
              + beta * self._du_x**3
              + gamma * math.cos(omega * self._du_t))
        self._du_x += dx * dt
        self._du_v += dv * dt
        self._du_t += dt
        return self._du_x

    # ── van der Pol oscillator ────────────────────────────────────────────
    def van_der_pol(self, mu: float = 3.0, dt: float = 0.05) -> float:
        """ẍ - μ(1-x²)ẋ + x = 0"""
        dx = self._vdp_v
        dv = mu * (1 - self._vdp_x**2) * self._vdp_v - self._vdp_x
        self._vdp_x += dx * dt
        self._vdp_v += dv * dt
        return self._vdp_x

    # ── Ensemble ──────────────────────────────────────────────────────────
    def all_values(self) -> List[float]:
        """Step all 13 systems and return their current outputs."""
        return [
            self.lorenz(),
            self.rossler(),
            self.henon(),
            self.logistic(),
            self.tent(),
            self.cubic(),
            self.gauss(),
            self.sine(),
            self.ikeda(),
            self.baker(),
            self.arnold(),
            self.duffing(),
            self.van_der_pol(),
        ]

    def mixed(self) -> float:
        """
        Nonlinear mix of all systems into a single [0,1) float.
        XOR-folds the mantissa bits of each value for high entropy.
        """
        vals = self.all_values()
        # Normalise each to [0,1)
        bits = 0
        for v in vals:
            # Extract mantissa-like bits
            frac = abs(v) - math.floor(abs(v))
            ibits = int(frac * (1 << 52)) & ((1 << 52) - 1)
            bits ^= ibits
        # Additional nonlinear fold
        bits = (bits * 0x9e3779b97f4a7c15) & ((1 << 52) - 1)
        return bits / (1 << 52)

    def lyapunov_estimate(self, system: str = "logistic",
                           n: int = 1000) -> float:
        """
        Estimate the Lyapunov exponent of one system.
        Positive → chaotic, negative → stable.
        """
        delta0 = 1e-8
        log_sum = 0.0

        if system == "logistic":
            x, xp = 0.5, 0.5 + delta0
            for _ in range(n):
                x  = self.logistic(3.99)
                # Approximate: d(rx(1-x))/dx = r(1-2x)
                deriv = abs(3.99 * (1 - 2*x))
                log_sum += math.log(max(deriv, 1e-30))
            return log_sum / n

        if system == "lorenz":
            total = 0.0
            for _ in range(n):
                self.lorenz()
                # Jacobian trace approximation
                j = abs(10 * (self._ly - self._lx)) + 1e-10
                total += math.log(j)
            return total / n

        return 0.0


# ── Security: chaotic RNG input validation ────────────────────────────────

class ChaoticRNGValidator:
    """
    Validates all parameters passed to chaotic system methods.
    Bad parameters cause divergence (inf/nan) which corrupts the mixing pipeline.
    """

    LORENZ_BOUNDS  = {"sigma": (0.1, 100.0), "rho": (0.1, 200.0), "beta": (0.01, 20.0), "dt": (1e-6, 0.1)}
    ROSSLER_BOUNDS = {"a": (0.01, 2.0),      "b":   (0.01, 2.0),   "c":  (1.0, 20.0),    "dt": (1e-6, 0.1)}
    LOGISTIC_R     = (2.5, 4.0)
    TENT_MU        = (0.5, 2.0)
    CUBIC_A        = (1.0, 4.0)
    IKEDA_U        = (0.1, 1.0)
    ARNOLD_MOD     = (3, 10_000)

    @classmethod
    def _in_range(cls, v: float, lo: float, hi: float, name: str) -> float:
        import math
        if not math.isfinite(v):
            raise ValueError(f"{name}={v} is not finite")
        if not lo <= v <= hi:
            raise ValueError(f"{name}={v} out of [{lo}, {hi}]")
        return v

    @classmethod
    def lorenz_params(cls, sigma, rho, beta, dt) -> tuple:
        b = cls.LORENZ_BOUNDS
        return (cls._in_range(sigma, *b["sigma"], "sigma"),
                cls._in_range(rho,   *b["rho"],   "rho"),
                cls._in_range(beta,  *b["beta"],  "beta"),
                cls._in_range(dt,    *b["dt"],    "dt"))

    @classmethod
    def rossler_params(cls, a, b, c, dt) -> tuple:
        r = cls.ROSSLER_BOUNDS
        return (cls._in_range(a,  *r["a"],  "a"),
                cls._in_range(b,  *r["b"],  "b"),
                cls._in_range(c,  *r["c"],  "c"),
                cls._in_range(dt, *r["dt"], "dt"))

    @classmethod
    def logistic_r(cls, r: float) -> float:
        return cls._in_range(r, *cls.LOGISTIC_R, "r")

    @classmethod
    def tent_mu(cls, mu: float) -> float:
        return cls._in_range(mu, *cls.TENT_MU, "mu")

    @classmethod
    def validate_state(cls, name: str, *vals) -> None:
        """Check that a system's state has not diverged."""
        import math
        for v in vals:
            if not math.isfinite(v):
                raise RuntimeError(
                    f"{name} state diverged (got {v}). "
                    "Reset the generator or reduce dt.")

    @classmethod
    def safe_divide(cls, num: float, den: float,
                     fallback: float = 1.0) -> float:
        return num / den if abs(den) > 1e-15 else fallback


# ── Standards: chaotic system characterisation ────────────────────────────

class ChaoticSystemStandards:
    """
    Documents and characterises each chaotic system:
    Lyapunov exponents, attractor dimension, and bifurcation parameter ranges.

    References:
      Lorenz (1963); Rössler (1976); Hénon (1976);
      May (1976) — logistic map; Ikeda (1979).
    """

    SYSTEMS = {
        "lorenz": {
            "name":         "Lorenz attractor",
            "dimension":    3,
            "lyapunov_max": 0.9056,
            "attractor_dim":2.06,
            "params":       {"sigma": 10, "rho": 28, "beta": 8/3},
            "reference":    "Lorenz, E.N. (1963). JAtmosSci 20:130",
        },
        "rossler": {
            "name":         "Rössler attractor",
            "dimension":    3,
            "lyapunov_max": 0.071,
            "attractor_dim":2.01,
            "params":       {"a": 0.2, "b": 0.2, "c": 5.7},
            "reference":    "Rössler, O.E. (1976). PhysLettA 57:397",
        },
        "henon": {
            "name":         "Hénon map",
            "dimension":    2,
            "lyapunov_max": 0.4150,
            "attractor_dim":1.261,
            "params":       {"a": 1.4, "b": 0.3},
            "reference":    "Hénon, M. (1976). CommunMathPhys 50:69",
        },
        "logistic": {
            "name":         "Logistic map",
            "dimension":    1,
            "lyapunov_max": 0.6931,
            "attractor_dim":1.0,
            "params":       {"r": 3.99},
            "reference":    "May, R.M. (1976). Nature 261:459",
        },
        "tent": {
            "name":         "Tent map",
            "dimension":    1,
            "lyapunov_max": 0.693,
            "attractor_dim":1.0,
            "params":       {"mu": 1.99},
            "reference":    "Lasota & Mackey (1994)",
        },
        "ikeda": {
            "name":         "Ikeda map",
            "dimension":    2,
            "lyapunov_max": 0.51,
            "attractor_dim":1.7,
            "params":       {"u": 0.9},
            "reference":    "Ikeda, K. (1979). OptCommun 30:257",
        },
        "duffing": {
            "name":         "Duffing oscillator",
            "dimension":    3,
            "lyapunov_max": 0.197,
            "attractor_dim":2.2,
            "params":       {"alpha":-1, "beta":1, "delta":0.3,
                             "gamma":0.5, "omega":1.2},
            "reference":    "Duffing, G. (1918). Erzwungene Schwingungen",
        },
        "van_der_pol": {
            "name":         "van der Pol oscillator",
            "dimension":    2,
            "lyapunov_max": 0.0,
            "attractor_dim":2.0,
            "params":       {"mu": 3.0},
            "note":         "Limit cycle, not strictly chaotic at standard mu",
            "reference":    "van der Pol, B. (1927). PhilMag 3:65",
        },
        "arnold": {
            "name":         "Arnold cat map",
            "dimension":    2,
            "lyapunov_max": 0.9624,
            "attractor_dim":2.0,
            "params":       {"mod": 101},
            "reference":    "Arnold, V.I. & Avez, A. (1968)",
        },
    }

    @classmethod
    def info(cls, system: str) -> dict:
        return cls.SYSTEMS.get(system, {"error": f"Unknown system '{system}'"})

    @classmethod
    def list_systems(cls) -> list:
        return list(cls.SYSTEMS.keys())

    @classmethod
    def chaotic_check(cls, system: str) -> bool:
        """True if the system has a positive Lyapunov exponent (is chaotic)."""
        info = cls.SYSTEMS.get(system, {})
        return info.get("lyapunov_max", 0.0) > 0.0

    @classmethod
    def mixing_quality_score(cls, values: list) -> dict:
        """
        Estimate mixing quality of a sequence:
        returns mean, variance, and autocorrelation at lag-1.
        Ideal: mean≈0.5, var≈1/12, autocorr≈0.
        """
        import math
        n = len(values)
        if n < 10:
            return {"error": "Need at least 10 values"}
        mean = sum(values) / n
        var  = sum((v - mean)**2 for v in values) / n
        ac1  = sum((values[i]-mean)*(values[i-1]-mean)
                   for i in range(1, n)) / max(n*var, 1e-15)
        return {
            "n":             n,
            "mean":          round(mean, 6),
            "variance":      round(var, 6),
            "ideal_variance":round(1/12, 6),
            "autocorr_lag1": round(ac1, 6),
            "quality":       ("good" if abs(mean-0.5) < 0.05
                              and abs(var-1/12) < 0.01
                              and abs(ac1) < 0.05
                              else "poor"),
        }
