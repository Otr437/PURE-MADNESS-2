"""
Mathematical and physical constants.
"""
import math
from decimal import Decimal


class MathConstants:
    # ── Core ──────────────────────────────────────────────────────────────
    PI           = math.pi
    TAU          = math.tau
    E            = math.e
    PHI          = (1 + math.sqrt(5)) / 2          # Golden ratio
    PHI_CONJ     = (1 - math.sqrt(5)) / 2          # Conjugate golden ratio
    SQRT2        = math.sqrt(2)
    SQRT3        = math.sqrt(3)
    SQRT5        = math.sqrt(5)
    LN2          = math.log(2)
    LN10         = math.log(10)
    LOG2E        = math.log2(math.e)
    LOG10E       = math.log10(math.e)

    # ── Named constants ───────────────────────────────────────────────────
    EULER_GAMMA  = 0.5772156649015328606065120900824024310421   # Euler-Mascheroni
    CATALAN      = 0.9159655941772190150546035149323841107741   # Catalan's constant
    APERY        = 1.2020569031595942853997381615114499907650   # ζ(3)
    KHINCHIN     = 2.6854520010653064453097148354817956938203   # Khinchin's constant
    TWIN_PRIME   = 0.6601618158468695739278121340571201978227   # Twin prime constant
    FEIGENBAUM1  = 4.6692016091029906718532038204662016172581   # δ — period doubling
    FEIGENBAUM2  = 2.5029078750958928222839028732182157863813   # α
    OMEGA        = 0.5671432904097838729999686622103555497538   # Ω — Lambert W(1)
    PLASTIC      = 1.3247179572447460259609088544780973407344   # Plastic constant
    SILVER       = 1.0 + math.sqrt(2)                          # Silver ratio
    LIOUVILLE    = 0.1100010000000000000000010000000000000000   # Liouville's number (approx)
    PROUHET_THUE = 0.4124540336401075977833613682967776158998   # Prouhet–Thue–Morse constant
    MEISSEL_MERT = 0.2615021853200914359433677013836816080467   # Meissel–Mertens constant

    # ── Physical constants (SI) ───────────────────────────────────────────
    SPEED_OF_LIGHT      = 299_792_458.0             # m/s
    PLANCK              = 6.62607015e-34             # J·s
    PLANCK_REDUCED      = 1.054571817e-34            # ħ = h/(2π)
    BOLTZMANN           = 1.380649e-23               # J/K
    AVOGADRO            = 6.02214076e23              # mol⁻¹
    ELEMENTARY_CHARGE   = 1.602176634e-19            # C
    ELECTRON_MASS       = 9.1093837015e-31           # kg
    PROTON_MASS         = 1.67262192369e-27          # kg
    NEUTRON_MASS        = 1.67492749804e-27          # kg
    GRAVITATIONAL       = 6.67430e-11                # m³ kg⁻¹ s⁻²
    FINE_STRUCTURE      = 7.2973525693e-3            # dimensionless α
    RYDBERG             = 10_973_731.568160          # m⁻¹
    VACUUM_PERMITTIVITY = 8.8541878128e-12           # F/m
    VACUUM_PERMEABILITY = 1.25663706212e-6           # N/A²
    GAS_CONSTANT        = 8.314462618                # J mol⁻¹ K⁻¹
    FARADAY             = 96_485.33212               # C/mol
    STEFAN_BOLTZMANN    = 5.670374419e-8             # W m⁻² K⁻⁴
    WIEN_DISPLACEMENT   = 2.897771955e-3             # m·K

    # ── High-precision decimals ───────────────────────────────────────────
    PI_DEC   = Decimal("3.14159265358979323846264338327950288419716939937510")
    E_DEC    = Decimal("2.71828182845904523536028747135266249775724709369995")
    PHI_DEC  = Decimal("1.61803398874989484820458683436563811772030917980576")

    @classmethod
    def all_math(cls) -> dict:
        """Return all pure mathematical constants as a dict."""
        skip = {"SPEED_OF_LIGHT","PLANCK","PLANCK_REDUCED","BOLTZMANN","AVOGADRO",
                "ELEMENTARY_CHARGE","ELECTRON_MASS","PROTON_MASS","NEUTRON_MASS",
                "GRAVITATIONAL","FINE_STRUCTURE","RYDBERG","VACUUM_PERMITTIVITY",
                "VACUUM_PERMEABILITY","GAS_CONSTANT","FARADAY","STEFAN_BOLTZMANN",
                "WIEN_DISPLACEMENT","PI_DEC","E_DEC","PHI_DEC"}
        return {k: v for k, v in vars(cls).items()
                if not k.startswith("_") and k not in skip and not callable(v)}

    @classmethod
    def all_physical(cls) -> dict:
        phys = {"SPEED_OF_LIGHT","PLANCK","PLANCK_REDUCED","BOLTZMANN","AVOGADRO",
                "ELEMENTARY_CHARGE","ELECTRON_MASS","PROTON_MASS","NEUTRON_MASS",
                "GRAVITATIONAL","FINE_STRUCTURE","RYDBERG","VACUUM_PERMITTIVITY",
                "VACUUM_PERMEABILITY","GAS_CONSTANT","FARADAY","STEFAN_BOLTZMANN",
                "WIEN_DISPLACEMENT"}
        return {k: getattr(cls, k) for k in phys}


# ── Extended constants: mathematical sequences and combinatorial ──────────

import math
from decimal import Decimal
from typing import Dict, List, Optional


class MathSequences:
    """
    Classic integer and real sequences:
    Fibonacci, Lucas, Catalan, Bell, Bernoulli, Euler numbers,
    prime-related constants, and their generating functions.
    """

    @staticmethod
    def fibonacci(n: int) -> int:
        """nth Fibonacci number (0-indexed)."""
        if n < 0:  raise ValueError("n must be >= 0")
        a, b = 0, 1
        for _ in range(n): a, b = b, a+b
        return a

    @staticmethod
    def fibonacci_sequence(n: int) -> List[int]:
        seq = [0, 1]
        for _ in range(n-2): seq.append(seq[-1]+seq[-2])
        return seq[:n]

    @staticmethod
    def lucas(n: int) -> int:
        a, b = 2, 1
        for _ in range(n): a, b = b, a+b
        return a

    @staticmethod
    def catalan(n: int) -> int:
        return math.comb(2*n, n) // (n+1)

    @staticmethod
    def catalan_sequence(n: int) -> List[int]:
        return [MathSequences.catalan(k) for k in range(n)]

    @staticmethod
    def bell(n: int) -> int:
        """Bell number B_n (number of partitions of a set of n elements)."""
        row = [1]
        for _ in range(n):
            new_row = [row[-1]]
            for j in range(len(row)-1):
                new_row.append(new_row[-1] + row[j])
            new_row.append(new_row[-1] + row[-1])
            row = new_row
        return row[0]

    @staticmethod
    def bernoulli(n: int) -> float:
        """Bernoulli number B_n (rational — returned as float)."""
        from fractions import Fraction
        if n == 0: return 1.0
        if n == 1: return -0.5
        if n % 2 == 1: return 0.0
        B = [Fraction(0)] * (n+1)
        B[0] = Fraction(1)
        for m in range(1, n+1):
            B[m] = -sum(math.comb(m+1, k)*B[k]
                        for k in range(m)) / (m+1)
        return float(B[n])

    @staticmethod
    def euler_numbers(n: int) -> List[int]:
        """First n Euler numbers E_0, E_1, …, E_{n-1}."""
        E = [0]*(n+1); E[0] = 1
        for k in range(2, n+1, 2):
            E[k] = -sum(math.comb(k, j)*E[j]
                        for j in range(0, k, 2))
        return E[:n]

    @staticmethod
    def padovan(n: int) -> int:
        """Padovan sequence P(n): P(n) = P(n-2) + P(n-3)."""
        if n < 3: return 1
        a, b, c = 1, 1, 1
        for _ in range(n-2): a, b, c = b, c, a+b
        return c

    @staticmethod
    def sylvester(n: int) -> int:
        """Sylvester sequence a_n = a_{n-1}*(a_{n-1}-1)+1."""
        a = 2
        for _ in range(n): a = a*(a-1)+1
        return a

    @staticmethod
    def recaman(n: int) -> List[int]:
        """Recamán sequence: a_n = a_{n-1}-n if positive and not seen, else a_{n-1}+n."""
        seq = [0]; seen = {0}
        for k in range(1, n+1):
            cand = seq[-1] - k
            if cand > 0 and cand not in seen:
                seq.append(cand)
            else:
                seq.append(seq[-1] + k)
            seen.add(seq[-1])
        return seq


class PhysicsConstants:
    """
    CODATA 2022 recommended fundamental physical constants.
    All values in SI units unless noted.
    """

    # Speed of light
    c       = 299_792_458.0           # m/s (exact)
    # Planck
    h       = 6.62607015e-34          # J·s
    hbar    = 1.054571817e-34         # J·s (ħ = h/2π)
    # Gravitational
    G       = 6.67430e-11             # m³ kg⁻¹ s⁻²
    # Boltzmann
    k_B     = 1.380649e-23            # J/K
    # Elementary charge
    e       = 1.602176634e-19         # C
    # Avogadro
    N_A     = 6.02214076e23           # mol⁻¹
    # Electron rest mass
    m_e     = 9.1093837015e-31        # kg
    # Proton rest mass
    m_p     = 1.67262192369e-27       # kg
    # Neutron rest mass
    m_n     = 1.67492749804e-27       # kg
    # Muon mass
    m_mu    = 1.883531627e-28         # kg
    # Fine-structure constant
    alpha   = 7.2973525693e-3         # dimensionless
    # Rydberg constant
    R_inf   = 10_973_731.568160       # m⁻¹
    # Bohr radius
    a_0     = 5.29177210903e-11       # m
    # Magnetic flux quantum
    Phi_0   = 2.067833848e-15         # Wb
    # Conductance quantum
    G_0     = 7.748091729e-5          # S
    # Stefan-Boltzmann
    sigma   = 5.670374419e-8          # W m⁻² K⁻⁴
    # Wien displacement
    b_Wien  = 2.897771955e-3          # m·K
    # Vacuum permittivity
    eps_0   = 8.8541878128e-12        # F/m
    # Vacuum permeability
    mu_0    = 1.25663706212e-6        # N/A²
    # Gas constant
    R       = 8.314462618             # J mol⁻¹ K⁻¹
    # Faraday
    F       = 96_485.33212            # C/mol
    # Standard atmosphere
    atm     = 101_325.0               # Pa
    # Standard gravity
    g       = 9.80665                 # m/s²

    @classmethod
    def de_broglie_wavelength(cls, mass: float, velocity: float) -> float:
        """λ = h / (mv)"""
        return cls.h / (mass * velocity)

    @classmethod
    def thermal_energy(cls, T: float) -> float:
        """k_B T in Joules"""
        return cls.k_B * T

    @classmethod
    def schwarzschild_radius(cls, mass: float) -> float:
        """r_s = 2GM/c²"""
        return 2 * cls.G * mass / cls.c**2


# ── Security: constants access control ───────────────────────────────────

class ConstantsValidator:
    """
    Validates constant lookups and derived calculations.
    Prevents division-by-zero and domain errors in physics formulas.
    """

    @staticmethod
    def positive(v: float, name: str = "value") -> float:
        if v <= 0:
            raise ValueError(f"{name} must be positive, got {v}")
        return v

    @staticmethod
    def non_zero(v: float, name: str = "value") -> float:
        if v == 0:
            raise ZeroDivisionError(f"{name} must not be zero")
        return v

    @staticmethod
    def kelvin(T: float) -> float:
        if T < 0:
            raise ValueError(f"Temperature {T} K is below absolute zero")
        return T

    @staticmethod
    def velocity(v: float) -> float:
        if abs(v) >= PhysicsConstants.c:
            raise ValueError(f"velocity {v} m/s >= c — physically impossible")
        return v

    @staticmethod
    def sequence_index(n: int, max_n: int = 10_000) -> int:
        if not isinstance(n, int) or n < 0:
            raise ValueError("Sequence index must be non-negative int")
        if n > max_n:
            raise ValueError(f"Index {n} exceeds safe max {max_n}")
        return n


# ── Standards: constants documentation ───────────────────────────────────

CONSTANTS_REFERENCE = {
    # Mathematical
    "π  (pi)":            {"value": math.pi,           "source": "IEEE 754"},
    "e  (Euler's)":       {"value": math.e,            "source": "IEEE 754"},
    "φ  (golden ratio)":  {"value": (1+math.sqrt(5))/2,"source": "Classic"},
    "γ  (Euler-Mascheroni)":{"value": 0.5772156649,    "source": "OEIS A001620"},
    "G  (Catalan)":       {"value": 0.9159655942,      "source": "OEIS A006752"},
    "ζ(3) (Apéry)":       {"value": 1.2020569032,      "source": "OEIS A002117"},
    # Physical
    "c  (speed of light)": {"value": 299_792_458,      "unit": "m/s",  "source": "CODATA 2022"},
    "h  (Planck)":         {"value": 6.62607015e-34,   "unit": "J·s",  "source": "CODATA 2022"},
    "k_B (Boltzmann)":     {"value": 1.380649e-23,     "unit": "J/K",  "source": "CODATA 2022"},
    "G  (gravitational)":  {"value": 6.67430e-11,      "unit": "m³/(kg·s²)", "source": "CODATA 2022"},
    "e  (elem. charge)":   {"value": 1.602176634e-19,  "unit": "C",    "source": "CODATA 2022"},
    "N_A (Avogadro)":      {"value": 6.02214076e23,    "unit": "mol⁻¹","source": "CODATA 2022"},
}


def lookup_constant(name: str) -> Optional[dict]:
    """Case-insensitive constant lookup from the reference table."""
    lo = name.lower()
    for key, val in CONSTANTS_REFERENCE.items():
        if lo in key.lower():
            return {"name": key, **val}
    return None


def list_constants(category: str = "all") -> Dict[str, dict]:
    """List constants by category: 'math', 'physical', or 'all'."""
    if category == "math":
        return {k: v for k, v in CONSTANTS_REFERENCE.items()
                if "unit" not in v}
    if category == "physical":
        return {k: v for k, v in CONSTANTS_REFERENCE.items()
                if "unit" in v}
    return CONSTANTS_REFERENCE
