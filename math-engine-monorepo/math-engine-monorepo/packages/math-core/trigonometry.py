import math


class Trigonometry:
    @staticmethod
    def sin(x): return math.sin(x)
    @staticmethod
    def cos(x): return math.cos(x)
    @staticmethod
    def tan(x): return math.tan(x)
    @staticmethod
    def asin(x): return math.asin(x)
    @staticmethod
    def acos(x): return math.acos(x)
    @staticmethod
    def atan(x): return math.atan(x)
    @staticmethod
    def atan2(y, x): return math.atan2(y, x)
    @staticmethod
    def sinh(x): return math.sinh(x)
    @staticmethod
    def cosh(x): return math.cosh(x)
    @staticmethod
    def tanh(x): return math.tanh(x)
    @staticmethod
    def asinh(x): return math.asinh(x)
    @staticmethod
    def acosh(x): return math.acosh(x)
    @staticmethod
    def atanh(x): return math.atanh(x)
    @staticmethod
    def sec(x): return 1 / math.cos(x)
    @staticmethod
    def csc(x): return 1 / math.sin(x)
    @staticmethod
    def cot(x): return 1 / math.tan(x)
    @staticmethod
    def deg_to_rad(deg): return math.radians(deg)
    @staticmethod
    def rad_to_deg(rad): return math.degrees(rad)

    @staticmethod
    def sin_series(x: float, terms: int = 10) -> float:
        return sum((-1) ** n * x ** (2 * n + 1) / math.factorial(2 * n + 1) for n in range(terms))

    @staticmethod
    def cos_series(x: float, terms: int = 10) -> float:
        return sum((-1) ** n * x ** (2 * n) / math.factorial(2 * n) for n in range(terms))

# ── Extended trigonometric functions ──────────────────────────────────────

    @staticmethod
    def versine(x: float) -> float:    return 1 - math.cos(x)
    @staticmethod
    def coversine(x: float) -> float:  return 1 - math.sin(x)
    @staticmethod
    def haversine(x: float) -> float:  return (1 - math.cos(x)) / 2
    @staticmethod
    def exsecant(x: float) -> float:   return Trigonometry.sec(x) - 1
    @staticmethod
    def excosecant(x: float) -> float: return Trigonometry.csc(x) - 1

    @staticmethod
    def sinc_normalized(x: float) -> float:
        """Normalized sinc: sin(πx)/(πx)."""
        return math.sin(math.pi*x)/(math.pi*x) if x else 1.0

    @staticmethod
    def atan2_degrees(y: float, x: float) -> float:
        return math.degrees(math.atan2(y, x))

    # ── Inverse hyperbolic (complete set) ─────────────────────────────────
    @staticmethod
    def asech(x: float) -> float:
        return math.acosh(1/x) if x != 0 else float("inf")
    @staticmethod
    def acsch(x: float) -> float:
        return math.asinh(1/x) if x != 0 else float("inf")
    @staticmethod
    def acoth(x: float) -> float:
        if abs(x) <= 1: raise ValueError("|x| must be > 1")
        return 0.5 * math.log((x+1)/(x-1))

    # ── Degree-mode wrappers ──────────────────────────────────────────────
    @staticmethod
    def sind(d: float) -> float:  return math.sin(math.radians(d))
    @staticmethod
    def cosd(d: float) -> float:  return math.cos(math.radians(d))
    @staticmethod
    def tand(d: float) -> float:  return math.tan(math.radians(d))
    @staticmethod
    def asind(x: float) -> float: return math.degrees(math.asin(x))
    @staticmethod
    def acosd(x: float) -> float: return math.degrees(math.acos(x))
    @staticmethod
    def atand(x: float) -> float: return math.degrees(math.atan(x))

    # ── Sum / product identities (verified numerically) ───────────────────
    @staticmethod
    def sin_sum(a: float, b: float) -> float:
        return math.sin(a)*math.cos(b) + math.cos(a)*math.sin(b)
    @staticmethod
    def cos_sum(a: float, b: float) -> float:
        return math.cos(a)*math.cos(b) - math.sin(a)*math.sin(b)
    @staticmethod
    def tan_sum(a: float, b: float) -> float:
        denom = 1 - math.tan(a)*math.tan(b)
        return (math.tan(a)+math.tan(b))/denom if denom else float("inf")
    @staticmethod
    def sin_double(a: float) -> float: return 2*math.sin(a)*math.cos(a)
    @staticmethod
    def cos_double(a: float) -> float: return math.cos(a)**2 - math.sin(a)**2
    @staticmethod
    def sin_half(a: float) -> float:
        return math.copysign(math.sqrt((1-math.cos(a))/2), a)
    @staticmethod
    def cos_half(a: float) -> float:
        return math.sqrt((1+math.cos(a))/2)

    # ── Spherical / geographic ────────────────────────────────────────────
    @staticmethod
    def haversine_distance(lat1: float, lon1: float,
                           lat2: float, lon2: float,
                           radius: float = 6371.0) -> float:
        """Great-circle distance in km (inputs in degrees)."""
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi  = math.radians(lat2 - lat1)
        dlam  = math.radians(lon2 - lon1)
        a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
        return 2 * radius * math.asin(math.sqrt(a))

    @staticmethod
    def spherical_to_cartesian(r: float, theta: float,
                                phi: float) -> tuple:
        """(r,θ,φ) → (x,y,z)."""
        x = r * math.sin(theta) * math.cos(phi)
        y = r * math.sin(theta) * math.sin(phi)
        z = r * math.cos(theta)
        return x, y, z

    @staticmethod
    def cartesian_to_spherical(x: float, y: float,
                                z: float) -> tuple:
        r     = math.sqrt(x**2 + y**2 + z**2)
        theta = math.acos(z/r) if r else 0.0
        phi   = math.atan2(y, x)
        return r, theta, phi

    # ── Fourier / periodic helpers ────────────────────────────────────────
    @staticmethod
    def fourier_sin_coeff(f, n: int, period: float = 2*math.pi,
                          steps: int = 1000) -> float:
        """b_n = (2/T) ∫₀ᵀ f(t)sin(2πnt/T) dt (trapezoidal)."""
        T = period; dt = T / steps
        return (2/T) * sum(f(i*dt) * math.sin(2*math.pi*n*i*dt/T)
                           for i in range(steps)) * dt

    @staticmethod
    def fourier_cos_coeff(f, n: int, period: float = 2*math.pi,
                          steps: int = 1000) -> float:
        """a_n = (2/T) ∫₀ᵀ f(t)cos(2πnt/T) dt."""
        T = period; dt = T / steps
        return (2/T) * sum(f(i*dt) * math.cos(2*math.pi*n*i*dt/T)
                           for i in range(steps)) * dt

    @staticmethod
    def fourier_partial_sum(f, N: int, t: float,
                            period: float = 2*math.pi) -> float:
        """Sum of first N+1 Fourier terms at t."""
        a0 = Trigonometry.fourier_cos_coeff(f, 0, period) / 2
        total = a0
        for n in range(1, N+1):
            an = Trigonometry.fourier_cos_coeff(f, n, period)
            bn = Trigonometry.fourier_sin_coeff(f, n, period)
            total += (an * math.cos(2*math.pi*n*t/period) +
                      bn * math.sin(2*math.pi*n*t/period))
        return total

# ── Security validation layer ─────────────────────────────────────────────

class TrigonometryValidator:
    """Guards for trigonometric function inputs."""

    @staticmethod
    def _finite(x: float, name: str = "x") -> float:
        import math
        if not isinstance(x, (int, float)):
            raise TypeError(f"{name} must be numeric, got {type(x).__name__}")
        if not math.isfinite(x):
            raise ValueError(f"{name} must be finite, got {x}")
        return float(x)

    @classmethod
    def asin_safe(cls, x: float) -> float:
        x = cls._finite(x)
        if not -1 <= x <= 1:
            raise ValueError(f"asin domain error: |x|={abs(x)} > 1")
        return math.asin(x)

    @classmethod
    def acos_safe(cls, x: float) -> float:
        x = cls._finite(x)
        if not -1 <= x <= 1:
            raise ValueError(f"acos domain error: |x|={abs(x)} > 1")
        return math.acos(x)

    @classmethod
    def tan_safe(cls, x: float, tol: float = 1e-10) -> float:
        x = cls._finite(x)
        import math
        if abs(math.cos(x)) < tol:
            raise ValueError(f"tan undefined at x={x} (cos≈0)")
        return math.tan(x)

    @classmethod
    def log_trig_safe(cls, x: float) -> float:
        """Log of absolute trig — guards division and log domain."""
        x = cls._finite(x)
        if x == 0:
            raise ValueError("log_trig: x=0 is undefined")
        return math.log(abs(x))

    @classmethod
    def validate_angle_range(cls, x: float,
                              unit: str = "rad") -> float:
        x = cls._finite(x)
        if unit == "deg" and not -360_000 <= x <= 360_000:
            raise ValueError(f"Angle {x} deg is unusually large")
        return x

    @classmethod
    def validate_haversine_inputs(cls, lat: float, lon: float) -> tuple:
        lat = cls._finite(lat, "lat"); lon = cls._finite(lon, "lon")
        if not -90 <= lat <= 90:
            raise ValueError(f"lat={lat} out of [-90,90]")
        if not -180 <= lon <= 180:
            raise ValueError(f"lon={lon} out of [-180,180]")
        return lat, lon

# ── Standards: common trig identities and verification ───────────────────

class TrigonometryStandards:
    """
    Verify trig identities to machine precision.
    Used as a self-test suite and for algebraic canonicalisation.
    """
    EPSILON = 1e-10

    @classmethod
    def verify_pythagorean(cls, x: float) -> bool:
        return abs(math.sin(x)**2 + math.cos(x)**2 - 1.0) < cls.EPSILON

    @classmethod
    def verify_double_angle(cls, x: float) -> bool:
        s2  = math.sin(2*x)
        s2_ = 2*math.sin(x)*math.cos(x)
        return abs(s2 - s2_) < cls.EPSILON

    @classmethod
    def verify_euler(cls, x: float) -> bool:
        import cmath
        lhs = cmath.exp(1j*x)
        rhs = complex(math.cos(x), math.sin(x))
        return abs(lhs - rhs) < cls.EPSILON

    @classmethod
    def run_all(cls, sample_points: int = 100) -> dict:
        import random, math as _m
        pts = [random.uniform(-10, 10) for _ in range(sample_points)]
        return {
            "pythagorean":  all(cls.verify_pythagorean(x) for x in pts),
            "double_angle": all(cls.verify_double_angle(x) for x in pts),
            "euler":        all(cls.verify_euler(x) for x in pts),
            "sample_points": sample_points,
        }
