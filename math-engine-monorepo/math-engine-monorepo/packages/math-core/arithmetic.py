"""
Extended Arithmetic — all basic operations plus integer algorithms,
base conversion, continued fractions, and big-integer helpers.
"""
import math
import cmath
from decimal import Decimal, getcontext
from fractions import Fraction
from typing import Any, List, Optional, Tuple


class Arithmetic:
    # ── Core ops (type-aware) ─────────────────────────────────────────────
    @staticmethod
    def add(a, b):
        if isinstance(a, complex) or isinstance(b, complex): return complex(a)+complex(b)
        if isinstance(a, Fraction) or isinstance(b, Fraction): return Fraction(a)+Fraction(b)
        if isinstance(a, Decimal) or isinstance(b, Decimal): return Decimal(str(a))+Decimal(str(b))
        return a + b

    @staticmethod
    def subtract(a, b):
        if isinstance(a, complex) or isinstance(b, complex): return complex(a)-complex(b)
        if isinstance(a, Fraction) or isinstance(b, Fraction): return Fraction(a)-Fraction(b)
        if isinstance(a, Decimal) or isinstance(b, Decimal): return Decimal(str(a))-Decimal(str(b))
        return a - b

    @staticmethod
    def multiply(a, b):
        if isinstance(a, complex) or isinstance(b, complex): return complex(a)*complex(b)
        if isinstance(a, Fraction) or isinstance(b, Fraction): return Fraction(a)*Fraction(b)
        if isinstance(a, Decimal) or isinstance(b, Decimal): return Decimal(str(a))*Decimal(str(b))
        return a * b

    @staticmethod
    def divide(a, b):
        if b == 0: raise ZeroDivisionError("Division by zero")
        if isinstance(a, complex) or isinstance(b, complex): return complex(a)/complex(b)
        if isinstance(a, Fraction) or isinstance(b, Fraction): return Fraction(a)/Fraction(b)
        if isinstance(a, Decimal) or isinstance(b, Decimal): return Decimal(str(a))/Decimal(str(b))
        return a / b

    @staticmethod
    def power(base, exponent):
        if isinstance(base, complex) or isinstance(exponent, complex): return complex(base)**complex(exponent)
        return base ** exponent

    @staticmethod
    def modulo(a: int, b: int) -> int: return a % b

    @staticmethod
    def floor_div(a: int, b: int) -> int: return a // b

    @staticmethod
    def abs_val(x): return abs(x)

    @staticmethod
    def sign(x) -> int:
        if x > 0: return 1
        if x < 0: return -1
        return 0

    @staticmethod
    def clamp(x, lo, hi): return max(lo, min(hi, x))

    @staticmethod
    def lerp(a: float, b: float, t: float) -> float:
        """Linear interpolation between a and b at parameter t ∈ [0,1]."""
        return a + t * (b - a)

    @staticmethod
    def round_to(x: float, decimals: int = 0) -> float:
        return round(x, decimals)

    @staticmethod
    def truncate(x: float) -> int:
        return int(x)

    # ── Integer algorithms ────────────────────────────────────────────────
    @staticmethod
    def gcd(a: int, b: int) -> int: return math.gcd(a, b)

    @staticmethod
    def lcm(a: int, b: int) -> int: return abs(a * b) // math.gcd(a, b)

    @staticmethod
    def gcd_multiple(nums: List[int]) -> int:
        from functools import reduce
        return reduce(math.gcd, nums)

    @staticmethod
    def lcm_multiple(nums: List[int]) -> int:
        from functools import reduce
        return reduce(lambda a, b: abs(a*b)//math.gcd(a,b), nums)

    @staticmethod
    def isqrt(n: int) -> int: return math.isqrt(n)

    @staticmethod
    def perfect_square(n: int) -> bool:
        r = math.isqrt(n); return r * r == n

    @staticmethod
    def perfect_cube(n: int) -> bool:
        r = round(n ** (1/3)); return r**3 == n or (r+1)**3 == n

    # ── Base conversion ───────────────────────────────────────────────────
    @staticmethod
    def to_base(n: int, base: int) -> str:
        """Convert non-negative integer n to given base (2–36)."""
        if n < 0: return '-' + Arithmetic.to_base(-n, base)
        if n == 0: return '0'
        digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        result = []
        while n:
            n, r = divmod(n, base)
            result.append(digits[r])
        return ''.join(reversed(result))

    @staticmethod
    def from_base(s: str, base: int) -> int:
        return int(s, base)

    @staticmethod
    def dec_to_bin(n: int) -> str: return bin(n)[2:]
    @staticmethod
    def dec_to_oct(n: int) -> str: return oct(n)[2:]
    @staticmethod
    def dec_to_hex(n: int) -> str: return hex(n)[2:].upper()
    @staticmethod
    def bin_to_dec(s: str) -> int: return int(s, 2)
    @staticmethod
    def hex_to_dec(s: str) -> int: return int(s, 16)

    # ── Continued fractions ───────────────────────────────────────────────
    @staticmethod
    def continued_fraction(x: float, max_terms: int = 20) -> List[int]:
        """Compute continued fraction expansion of x."""
        result = []
        for _ in range(max_terms):
            a = int(x)
            result.append(a)
            frac = x - a
            if abs(frac) < 1e-10: break
            x = 1.0 / frac
        return result

    @staticmethod
    def cf_convergent(cf: List[int], n: int) -> Fraction:
        """Compute the nth convergent of a continued fraction."""
        if n >= len(cf): n = len(cf) - 1
        h_prev, h_curr = 1, cf[0]
        k_prev, k_curr = 0, 1
        for i in range(1, n + 1):
            h_prev, h_curr = h_curr, cf[i] * h_curr + h_prev
            k_prev, k_curr = k_curr, cf[i] * k_curr + k_prev
        return Fraction(h_curr, k_curr)

    @staticmethod
    def best_rational_approx(x: float, max_denom: int = 1000) -> Fraction:
        """Best rational approximation with denominator ≤ max_denom."""
        return Fraction(x).limit_denominator(max_denom)

    # ── High-precision arithmetic ─────────────────────────────────────────
    @staticmethod
    def high_precision_pi(digits: int = 100) -> Decimal:
        """Compute π to given number of digits using Machin's formula."""
        getcontext().prec = digits + 10
        def arctan_series(x: Decimal, terms: int) -> Decimal:
            result = x; term = x; x2 = x * x
            for k in range(1, terms):
                term = -term * x2
                result += term / (2 * k + 1)
            return result
        terms = digits * 2
        pi = 4 * (4 * arctan_series(Decimal(1)/5, terms) -
                  arctan_series(Decimal(1)/239, terms))
        getcontext().prec = digits
        return +pi

    @staticmethod
    def high_precision_e(digits: int = 100) -> Decimal:
        """Compute e to given digits via Taylor series."""
        getcontext().prec = digits + 10
        result = Decimal(1)
        term   = Decimal(1)
        for k in range(1, digits * 3):
            term /= k
            result += term
            if term < Decimal(10) ** -(digits + 5): break
        getcontext().prec = digits
        return +result

    # ── Summation helpers ─────────────────────────────────────────────────
    @staticmethod
    def kahan_sum(values: List[float]) -> float:
        """Kahan compensated summation for numerical stability."""
        total = comp = 0.0
        for v in values:
            y = v - comp
            t = total + y
            comp = (t - total) - y
            total = t
        return total

    @staticmethod
    def pairwise_sum(values: List[float]) -> float:
        """Recursive pairwise summation."""
        n = len(values)
        if n == 0: return 0.0
        if n == 1: return values[0]
        mid = n // 2
        return Arithmetic.pairwise_sum(values[:mid]) + Arithmetic.pairwise_sum(values[mid:])

# ── Extended number utilities ─────────────────────────────────────────────

    @staticmethod
    def digital_root(n: int) -> int:
        n = abs(n)
        while n >= 10: n = sum(int(d) for d in str(n))
        return n

    @staticmethod
    def digit_sum(n: int) -> int:
        return sum(int(d) for d in str(abs(n)))

    @staticmethod
    def reverse_number(n: int) -> int:
        return int(str(abs(n))[::-1]) * (1 if n >= 0 else -1)

    @staticmethod
    def is_palindrome(n: int) -> bool:
        s = str(abs(n)); return s == s[::-1]

    @staticmethod
    def is_armstrong(n: int) -> bool:
        """Armstrong (narcissistic) number: 153 = 1³+5³+3³."""
        digits = [int(d) for d in str(n)]; k = len(digits)
        return sum(d**k for d in digits) == n

    @staticmethod
    def is_harshad(n: int) -> bool:
        """Harshad number: divisible by its digit sum."""
        return n % Arithmetic.digit_sum(n) == 0

    @staticmethod
    def next_fibonacci(n: int) -> int:
        """First Fibonacci number ≥ n."""
        import math
        phi = (1 + math.sqrt(5)) / 2
        k   = math.ceil(math.log(n * math.sqrt(5)) / math.log(phi)) if n > 1 else 1
        a, b = 0, 1
        while b < n: a, b = b, a+b
        return b

    @staticmethod
    def egyptian_fractions(num: int, den: int) -> List[Fraction]:
        """Decompose num/den into unit fractions (greedy algorithm)."""
        result = []; f = Fraction(num, den)
        while f > 0:
            unit = Fraction(1, math.ceil(1/f))
            result.append(unit); f -= unit
        return result

    @staticmethod
    def sylvester_sequence(n: int) -> List[int]:
        """Sylvester sequence: each term = product of previous + 1."""
        seq = [2]
        for _ in range(n-1):
            p = 1
            for x in seq: p *= x
            seq.append(p + 1)
        return seq

    @staticmethod
    def aliquot_sequence(n: int, max_steps: int = 100) -> List[int]:
        """Iterate s(n) = sum of proper divisors until cycle or 1."""
        import math
        seq = [n]
        seen = {n}
        for _ in range(max_steps):
            divs = [i for i in range(1, n) if n % i == 0]
            n = sum(divs)
            if n in seen or n <= 1: seq.append(n); break
            seen.add(n); seq.append(n)
        return seq

    @staticmethod
    def binary_gcd(a: int, b: int) -> int:
        """Stein's binary GCD algorithm."""
        if a == 0: return b
        if b == 0: return a
        if a % 2 == 0 and b % 2 == 0: return 2 * Arithmetic.binary_gcd(a//2, b//2)
        if a % 2 == 0: return Arithmetic.binary_gcd(a//2, b)
        if b % 2 == 0: return Arithmetic.binary_gcd(a, b//2)
        if a > b: return Arithmetic.binary_gcd((a-b)//2, b)
        return Arithmetic.binary_gcd((b-a)//2, a)

# ── Security: arithmetic input validation ────────────────────────────────

class ArithmeticValidator:
    """
    Validates arithmetic inputs against overflow, type errors,
    and malicious large inputs.
    """
    MAX_INT_BITS   = 10_000   # prevent extreme BigInt ops
    MAX_FACTORIAL  = 100_000
    MAX_POWER_EXP  = 10_000
    MAX_BASE       = 36

    @classmethod
    def validate_int(cls, n, name: str = "n") -> int:
        if not isinstance(n, int):
            raise TypeError(f"{name} must be int, got {type(n).__name__}")
        if n.bit_length() > cls.MAX_INT_BITS:
            raise ValueError(f"{name} too large ({n.bit_length()} bits)")
        return n

    @classmethod
    def validate_base(cls, base: int) -> int:
        if not 2 <= base <= cls.MAX_BASE:
            raise ValueError(f"base must be in [2,{cls.MAX_BASE}], got {base}")
        return base

    @classmethod
    def validate_factorial(cls, n: int) -> int:
        if n < 0:          raise ValueError("factorial undefined for negatives")
        if n > cls.MAX_FACTORIAL:
            raise ValueError(f"factorial({n}) too large (max {cls.MAX_FACTORIAL})")
        return n

    @classmethod
    def validate_power(cls, base, exp) -> tuple:
        if isinstance(exp, int) and exp > cls.MAX_POWER_EXP:
            raise ValueError(f"exponent {exp} exceeds max {cls.MAX_POWER_EXP}")
        return base, exp

    @classmethod
    def validate_division(cls, a, b) -> tuple:
        if b == 0:
            raise ZeroDivisionError("Division by zero")
        return a, b

    @classmethod
    def validate_cf_terms(cls, max_terms: int) -> int:
        if max_terms < 1 or max_terms > 10_000:
            raise ValueError(f"max_terms must be in [1,10000], got {max_terms}")
        return max_terms

# ── Standards: numeric format standards ──────────────────────────────────

class NumericStandards:
    """
    IEEE 754, SI prefix formatting, and engineering notation.
    Follows standards: IEEE 754-2008, NIST SI Guide 2008.
    """

    SI_PREFIXES = [
        (1e24,  "Y","yotta"), (1e21,  "Z","zetta"), (1e18,  "E","exa"),
        (1e15,  "P","peta"),  (1e12,  "T","tera"),  (1e9,   "G","giga"),
        (1e6,   "M","mega"),  (1e3,   "k","kilo"),  (1e-3,  "m","milli"),
        (1e-6,  "μ","micro"), (1e-9,  "n","nano"),  (1e-12, "p","pico"),
        (1e-15, "f","femto"), (1e-18, "a","atto"),  (1e-21, "z","zepto"),
        (1e-24, "y","yocto"),
    ]

    @staticmethod
    def to_si(value: float, unit: str = "", sig_figs: int = 4) -> str:
        import math
        if not math.isfinite(value): return str(value)
        for scale, sym, _ in NumericStandards.SI_PREFIXES:
            if abs(value) >= scale:
                return f"{round(value/scale, sig_figs)} {sym}{unit}"
        return f"{round(value, sig_figs)} {unit}"

    @staticmethod
    def to_engineering(value: float, sig_figs: int = 4) -> str:
        import math
        if value == 0: return "0"
        exp = int(math.floor(math.log10(abs(value))/3)*3)
        mant = value / 10**exp
        return f"{round(mant, sig_figs)}e{exp:+d}"

    @staticmethod
    def to_scientific(value: float, sig_figs: int = 6) -> str:
        return f"{value:.{sig_figs}e}"

    @staticmethod
    def is_ieee754_normal(x: float) -> bool:
        import math, struct
        if not isinstance(x, float): return False
        return math.isfinite(x) and x != 0.0 and not math.isnan(x)

    @staticmethod
    def ulp(x: float) -> float:
        """Unit of Least Precision for a float."""
        import math, struct
        if x == 0: return 5e-324
        n = struct.unpack("Q", struct.pack("d", abs(x)))[0]
        return abs(struct.unpack("d", struct.pack("Q", n+1))[0] - abs(x))

    @staticmethod
    def significant_figures(x: float, n: int) -> float:
        import math
        if x == 0: return 0.0
        d = math.ceil(math.log10(abs(x)))
        power = n - d
        factor = 10 ** power
        return round(x * factor) / factor

    @staticmethod
    def roman(n: int) -> str:
        """Convert integer to Roman numeral string."""
        if not 1 <= n <= 3999:
            raise ValueError("Roman numerals: 1–3999 only")
        vals = [(1000,"M"),(900,"CM"),(500,"D"),(400,"CD"),(100,"C"),
                (90,"XC"),(50,"L"),(40,"XL"),(10,"X"),(9,"IX"),
                (5,"V"),(4,"IV"),(1,"I")]
        result = ""
        for v, s in vals:
            while n >= v: result += s; n -= v
        return result

    @staticmethod
    def from_roman(s: str) -> int:
        vals = {"I":1,"V":5,"X":10,"L":50,"C":100,"D":500,"M":1000}
        result = 0
        for i, c in enumerate(s):
            v = vals.get(c, 0)
            if i+1 < len(s) and vals.get(s[i+1], 0) > v:
                result -= v
            else:
                result += v
        return result
