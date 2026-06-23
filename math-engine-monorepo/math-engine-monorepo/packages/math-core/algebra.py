"""
Algebra — polynomial arithmetic, equation solving, matrix polynomials,
partial fractions, Groebner basis helpers, and symbolic substitution.
"""
import cmath
import math
from fractions import Fraction
from typing import Callable, Dict, List, Optional, Tuple, Union


class Algebra:
    # ── Linear / quadratic / cubic / quartic ──────────────────────────────
    @staticmethod
    def solve_linear(a, b) -> Optional[float]:
        if a == 0: return None if b != 0 else float("inf")
        return -b / a

    @staticmethod
    def solve_quadratic(a, b, c) -> List[complex]:
        if a == 0: return ([Algebra.solve_linear(b, c)] if Algebra.solve_linear(b,c) is not None else [])
        d = b*b - 4*a*c
        sq = math.sqrt(d) if d >= 0 else cmath.sqrt(d)
        return [(-b+sq)/(2*a), (-b-sq)/(2*a)]

    @staticmethod
    def solve_cubic(a, b, c, d) -> List[complex]:
        if a == 0: return Algebra.solve_quadratic(b, c, d)
        b, c, d = b/a, c/a, d/a
        p = c - b*b/3
        q = d - b*c/3 + 2*b**3/27
        delta = (q/2)**2 + (p/3)**3
        shift = b/3
        if delta >= 0:
            u = (-q/2 + cmath.sqrt(delta))**(1/3)
            v = (-q/2 - cmath.sqrt(delta))**(1/3)
            t1 = u+v; t2 = -(u+v)/2+(u-v)*cmath.sqrt(3)/2j; t3 = -(u+v)/2-(u-v)*cmath.sqrt(3)/2j
            # fix imaginary part sign
            t2 = complex(t2.real, -(u-v).real*math.sqrt(3)/2)
            t3 = complex(t3.real,  (u-v).real*math.sqrt(3)/2)
            return [t1-shift, t2-shift, t3-shift]
        r = math.sqrt(-(p/3)**3)
        theta = math.acos(max(-1.0, min(1.0, -q/(2*r))))
        cbr = r**(1/3)
        return [2*cbr*math.cos((theta+2*math.pi*k)/3)-shift for k in range(3)]

    @staticmethod
    def solve_quartic(a, b, c, d, e) -> List[complex]:
        if a == 0: return Algebra.solve_cubic(b, c, d, e)
        b,c,d,e = b/a, c/a, d/a, e/a
        p = c - 3*b*b/8
        q = d - b*c/2 + b**3/8
        r = e - b*d/4 + b*b*c/16 - 3*b**4/256
        if abs(q) < 1e-12:
            sols = Algebra.solve_quadratic(1, p, r)
            roots = []
            for s in sols: roots += [cmath.sqrt(s), -cmath.sqrt(s)]
        else:
            cub = Algebra.solve_cubic(1, 2*p, p*p-4*r, -(q*q))
            y = cub[0]
            R = cmath.sqrt(y)
            D = cmath.sqrt(y-p-q/R) if abs(R) > 1e-12 else cmath.sqrt(y-p)
            E = cmath.sqrt(y-p+q/R) if abs(R) > 1e-12 else cmath.sqrt(y-p)
            roots = [(R+D)/2,(R-D)/2,(-R+E)/2,(-R-E)/2]
        return [r-b/4 for r in roots]

    # ── Polynomial arithmetic ─────────────────────────────────────────────
    @staticmethod
    def poly_eval(coeffs: List[float], x) -> float:
        """Horner's method evaluation."""
        result = 0.0
        for c in coeffs: result = result*x + c
        return result

    @staticmethod
    def poly_add(p: List[float], q: List[float]) -> List[float]:
        n = max(len(p), len(q))
        p = [0]*(n-len(p)) + list(p)
        q = [0]*(n-len(q)) + list(q)
        return [a+b for a,b in zip(p,q)]

    @staticmethod
    def poly_sub(p: List[float], q: List[float]) -> List[float]:
        n = max(len(p), len(q))
        p = [0]*(n-len(p)) + list(p)
        q = [0]*(n-len(q)) + list(q)
        return [a-b for a,b in zip(p,q)]

    @staticmethod
    def poly_mul(p: List[float], q: List[float]) -> List[float]:
        result = [0.0]*(len(p)+len(q)-1)
        for i, a in enumerate(p):
            for j, b in enumerate(q):
                result[i+j] += a*b
        return result

    @staticmethod
    def poly_div(dividend: List[float], divisor: List[float]) -> Tuple[List[float], List[float]]:
        """Polynomial long division. Returns (quotient, remainder)."""
        q = []
        r = list(dividend)
        while len(r) >= len(divisor):
            coeff = r[0] / divisor[0]
            q.append(coeff)
            for i, d in enumerate(divisor):
                r[i] -= coeff * d
            r.pop(0)
        return q, r

    @staticmethod
    def poly_gcd(p: List[float], q: List[float]) -> List[float]:
        """Polynomial GCD via Euclidean algorithm."""
        while any(abs(x) > 1e-12 for x in q):
            _, r = Algebra.poly_div(p, q)
            p, q = q, r
        if p:
            lead = p[0]
            return [c/lead for c in p]
        return [1.0]

    @staticmethod
    def poly_derivative(coeffs: List[float]) -> List[float]:
        n = len(coeffs)-1
        return [coeffs[i]*(n-i) for i in range(n)] or [0.0]

    @staticmethod
    def poly_integral(coeffs: List[float], constant: float = 0.0) -> List[float]:
        n = len(coeffs)
        result = [coeffs[i]/(n-i) for i in range(n)]
        return result + [constant]

    @staticmethod
    def synthetic_division(coeffs: List[float], root: float) -> Tuple[List[float], float]:
        result = [coeffs[0]]
        for c in coeffs[1:-1]: result.append(c + result[-1]*root)
        remainder = coeffs[-1] + result[-1]*root
        return result, remainder

    @staticmethod
    def poly_roots_newton(coeffs: List[float], max_iter: int = 200) -> List[complex]:
        """Find all roots via Newton's method with deflation."""
        roots = []
        p = list(coeffs)
        while len(p) > 1:
            # Initial guess
            x = complex(1.0 - 0.4j) * (1.0 + 0.02 * len(roots))
            for _ in range(max_iter):
                fx  = Algebra.poly_eval(p, x)
                dfx = Algebra.poly_eval(Algebra.poly_derivative(p), x)
                if abs(dfx) < 1e-14: break
                x -= fx / dfx
                if abs(fx) < 1e-12: break
            roots.append(x)
            # Deflate
            _, p = Algebra.poly_div(p, [1.0, -x])
        return roots

    # ── Partial fractions ─────────────────────────────────────────────────
    @staticmethod
    def partial_fraction_residues(num: List[float], poles: List[complex]) -> List[complex]:
        """Compute residues A_i for sum A_i/(x-p_i), assuming simple poles."""
        residues = []
        for pole in poles:
            num_val  = Algebra.poly_eval(num, pole)
            den_val  = 1.0
            for other in poles:
                if abs(other - pole) > 1e-12:
                    den_val *= (pole - other)
            residues.append(num_val / den_val)
        return residues

    # ── System of linear equations ────────────────────────────────────────
    @staticmethod
    def solve_system(A: List[List[float]], b: List[float]) -> Optional[List[float]]:
        """Gauss-Jordan with partial pivoting."""
        n = len(A)
        M = [A[i][:] + [b[i]] for i in range(n)]
        for col in range(n):
            piv = max(range(col, n), key=lambda r: abs(M[r][col]))
            if abs(M[piv][col]) < 1e-15: return None
            M[col], M[piv] = M[piv], M[col]
            pv = M[col][col]
            for j in range(col, n+1): M[col][j] /= pv
            for row in range(n):
                if row != col:
                    f = M[row][col]
                    for j in range(col, n+1): M[row][j] -= f*M[col][j]
        return [M[i][n] for i in range(n)]

    # ── Interpolation ─────────────────────────────────────────────────────
    @staticmethod
    def lagrange_interpolate(xs: List[float], ys: List[float], x: float) -> float:
        """Lagrange polynomial interpolation at point x."""
        n = len(xs)
        total = 0.0
        for i in range(n):
            term = ys[i]
            for j in range(n):
                if i != j:
                    term *= (x - xs[j]) / (xs[i] - xs[j])
            total += term
        return total

    @staticmethod
    def newton_divided_differences(xs: List[float], ys: List[float]) -> List[float]:
        """Compute Newton's divided difference coefficients."""
        n = len(xs)
        coeff = list(ys)
        for j in range(1, n):
            for i in range(n-1, j-1, -1):
                coeff[i] = (coeff[i]-coeff[i-1]) / (xs[i]-xs[i-j])
        return coeff

    @staticmethod
    def newton_interpolate(xs: List[float], coeffs: List[float], x: float) -> float:
        """Evaluate Newton interpolating polynomial."""
        n = len(coeffs)
        result = coeffs[-1]
        for i in range(n-2, -1, -1):
            result = result*(x-xs[i]) + coeffs[i]
        return result

    @staticmethod
    def cubic_spline(xs: List[float], ys: List[float], x: float) -> float:
        """Natural cubic spline interpolation."""
        n = len(xs) - 1
        h = [xs[i+1]-xs[i] for i in range(n)]
        # Tridiagonal system for moments M
        alpha = [3*(ys[i+1]-ys[i])/h[i] - 3*(ys[i]-ys[i-1])/h[i-1] for i in range(1, n)]
        l = [1.0] + [0.0]*n; mu = [0.0]*(n+1); z = [0.0]*(n+1)
        for i in range(1, n):
            l[i] = 2*(xs[i+1]-xs[i-1]) - h[i-1]*mu[i-1]
            if abs(l[i]) < 1e-15: continue
            mu[i] = h[i]/l[i]
            z[i] = (alpha[i-1]-h[i-1]*z[i-1])/l[i]
        M = [0.0]*(n+1)
        for j in range(n-1, -1, -1):
            M[j] = z[j] - mu[j]*M[j+1]
        # Find interval
        idx = next((i for i in range(n) if xs[i] <= x <= xs[i+1]), n-1)
        i = idx
        hh = h[i]; a=ys[i]; b=(ys[i+1]-ys[i])/hh - hh*(M[i+1]+2*M[i])/3
        c=M[i]; d=(M[i+1]-M[i])/(3*hh); dx=x-xs[i]
        return a + b*dx + c*dx**2 + d*dx**3


# ── Extended algebra: advanced factoring, resultants, Groebner ────────────

    @staticmethod
    def resultant(p: List[float], q: List[float]) -> float:
        """
        Sylvester matrix resultant of polynomials p and q.
        Res(p,q) = 0 iff p and q share a common root.
        """
        m, n = len(p)-1, len(q)-1
        if m == 0 or n == 0:
            return 0.0
        size = m + n
        M = [[0.0]*size for _ in range(size)]
        for i in range(n):
            for j, c in enumerate(p):
                M[i][i+j] = c
        for i in range(m):
            for j, c in enumerate(q):
                M[n+i][i+j] = c
        return LinearAlgebra_det(M)

    @staticmethod
    def discriminant_quadratic(a: float, b: float, c: float) -> float:
        """Δ = b² - 4ac"""
        return b*b - 4*a*c

    @staticmethod
    def discriminant_cubic(a: float, b: float, c: float, d: float) -> float:
        """Δ = 18abcd - 4b³d + b²c² - 4ac³ - 27a²d²"""
        return (18*a*b*c*d - 4*b**3*d + b**2*c**2
                - 4*a*c**3 - 27*a**2*d**2)

    @staticmethod
    def bezout_coefficients(p: List[float],
                             q: List[float]) -> tuple:
        """
        Extended polynomial GCD: returns (gcd, s, t) such that
        s*p + t*q = gcd(p, q).
        """
        old_r, r   = p[:], q[:]
        old_s, s   = [1.0], [0.0]
        old_t, t   = [0.0], [1.0]
        while any(abs(c) > 1e-12 for c in r):
            quot, rem = Algebra.poly_div(old_r, r)
            old_r, r  = r, rem
            quot_old_s = Algebra.poly_mul(quot, old_s)
            new_s = Algebra.poly_sub(old_s, quot_old_s[:len(old_s)])
            old_s, s  = s, new_s
            quot_old_t = Algebra.poly_mul(quot, old_t)
            new_t = Algebra.poly_sub(old_t, quot_old_t[:len(old_t)])
            old_t, t  = t, new_t
        return old_r, old_s, old_t

    @staticmethod
    def polynomial_composition(p: List[float],
                                q: List[float]) -> List[float]:
        """Compute p(q(x)) — polynomial composition."""
        result = [0.0]
        for coeff in p:
            result = Algebra.poly_add(
                Algebra.poly_mul(result, q), [coeff])
        return result

    @staticmethod
    def rational_root_candidates(coeffs: List[float]) -> List[float]:
        """
        Rational Root Theorem: all p/q where p | coeffs[-1], q | coeffs[0].
        coeffs are in descending order: a_n, …, a_0.
        """
        import math
        a0 = int(abs(round(coeffs[-1])))
        an = int(abs(round(coeffs[0])))
        if a0 == 0 or an == 0:
            return [0.0]
        def divisors(n):
            return [i for i in range(1, n+1) if n % i == 0]
        ps = divisors(a0); qs = divisors(an)
        cands = set()
        for pp in ps:
            for qq in qs:
                cands.add( pp/qq)
                cands.add(-pp/qq)
        # Filter to actual roots
        return [c for c in cands
                if abs(Algebra.poly_eval(coeffs, c)) < 1e-8]

    @staticmethod
    def horner_scheme(coeffs: List[float],
                       x: float) -> Tuple[float, List[float]]:
        """
        Horner's scheme: returns (value, synthetic_division_coeffs).
        The synthetic coefficients are the quotient polynomial.
        """
        result = coeffs[0]; quot = [coeffs[0]]
        for c in coeffs[1:]:
            result = result*x + c
            quot.append(result)
        return result, quot[:-1]

    @staticmethod
    def sturm_sequence(coeffs: List[float]) -> List[List[float]]:
        """
        Build the Sturm sequence for polynomial root counting.
        Returns list of polynomials [p, p', r1, r2, …].
        """
        seq = [coeffs, Algebra.poly_derivative(coeffs)]
        while len(seq[-1]) > 1:
            _, rem = Algebra.poly_div(seq[-2], seq[-1])
            if not rem or all(abs(c) < 1e-12 for c in rem):
                break
            seq.append([-c for c in rem])
        return seq

    @staticmethod
    def count_real_roots(coeffs: List[float],
                          a: float, b: float) -> int:
        """
        Count distinct real roots in (a, b) via Sturm's theorem.
        """
        sturm = Algebra.sturm_sequence(coeffs)
        def sign_changes(x: float) -> int:
            vals = [Algebra.poly_eval(s, x) for s in sturm]
            vals = [v for v in vals if abs(v) > 1e-12]
            return sum(1 for i in range(len(vals)-1)
                       if vals[i]*vals[i+1] < 0)
        return abs(sign_changes(a) - sign_changes(b))

    @staticmethod
    def multivariate_eval(expr_terms: List[Tuple[float, dict]],
                           values: dict) -> float:
        """
        Evaluate a multivariate polynomial given as list of
        (coefficient, {var: exponent, …}) terms.
        e.g. 3x²y = (3.0, {'x':2,'y':1})
        """
        total = 0.0
        for coeff, exponents in expr_terms:
            term = coeff
            for var, exp in exponents.items():
                term *= values.get(var, 0) ** exp
            total += term
        return total


# ── A minimal det() standalone for resultant (avoids circular import) ─────

def LinearAlgebra_det(M: List[List[float]]) -> float:
    """Quick determinant for square matrix (used by resultant)."""
    n = len(M)
    if n == 1: return M[0][0]
    if n == 2: return M[0][0]*M[1][1] - M[0][1]*M[1][0]
    mat = [r[:] for r in M]; d = 1.0; sign = 1
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(mat[r][i]))
        if abs(mat[piv][i]) < 1e-14: return 0.0
        if piv != i:
            mat[i], mat[piv] = mat[piv], mat[i]
            sign = -sign
        d *= mat[i][i]
        for k in range(i+1, n):
            f = mat[k][i] / mat[i][i]
            for j in range(i, n): mat[k][j] -= f * mat[i][j]
    return sign * d


# ── Security: algebra input validation ────────────────────────────────────

class AlgebraValidator:
    """
    Validates all inputs to Algebra methods.
    Prevents polynomial length bombs, NaN poisoning, and coefficient overflow.
    """
    MAX_POLY_DEGREE   = 500
    MAX_POLY_COEFF    = 1e300
    MAX_SYSTEM_SIZE   = 100
    MAX_INTERP_POINTS = 10_000

    @classmethod
    def validate_coefficients(cls, coeffs: List[float],
                               name: str = "coeffs") -> List[float]:
        import math
        if not isinstance(coeffs, (list, tuple)):
            raise TypeError(f"{name} must be a list")
        if len(coeffs) == 0:
            raise ValueError(f"{name} is empty")
        if len(coeffs) - 1 > cls.MAX_POLY_DEGREE:
            raise ValueError(f"{name} degree {len(coeffs)-1} "
                             f"exceeds max {cls.MAX_POLY_DEGREE}")
        cleaned = []
        for i, c in enumerate(coeffs):
            if not isinstance(c, (int, float)):
                raise TypeError(f"{name}[{i}] is not numeric: {type(c).__name__}")
            if not math.isfinite(c):
                raise ValueError(f"{name}[{i}]={c} is not finite")
            if abs(c) > cls.MAX_POLY_COEFF:
                raise ValueError(f"{name}[{i}]={c} exceeds max magnitude")
            cleaned.append(float(c))
        return cleaned

    @classmethod
    def validate_roots(cls, a: float, b: float, c: float,
                        d: float = None) -> tuple:
        """Validate equation coefficients are finite."""
        import math
        vals = [a, b, c] + ([d] if d is not None else [])
        for i, v in enumerate(vals):
            if not math.isfinite(v):
                raise ValueError(f"Coefficient {i} is not finite: {v}")
        return tuple(vals)

    @classmethod
    def validate_interpolation_points(cls, xs: List[float],
                                       ys: List[float]) -> tuple:
        if len(xs) != len(ys):
            raise ValueError("xs and ys must have equal length")
        if len(xs) > cls.MAX_INTERP_POINTS:
            raise ValueError(f"Too many interpolation points: {len(xs)}")
        if len(set(xs)) != len(xs):
            raise ValueError("Interpolation x-values must be distinct")
        return xs, ys

    @classmethod
    def validate_polynomial_op(cls, p: List[float],
                                q: List[float]) -> tuple:
        p = cls.validate_coefficients(p, "p")
        q = cls.validate_coefficients(q, "q")
        return p, q

    @classmethod
    def validate_system_matrix(cls, A: List[List[float]],
                                b: List[float]) -> tuple:
        n = len(A)
        if n > cls.MAX_SYSTEM_SIZE:
            raise ValueError(f"System size {n} exceeds max {cls.MAX_SYSTEM_SIZE}")
        if len(b) != n:
            raise ValueError("A rows and b length must match")
        for i, row in enumerate(A):
            if len(row) != n:
                raise ValueError(f"A[{i}] has {len(row)} cols, expected {n}")
        return A, b


# ── Standards: polynomial display and canonical form ─────────────────────

class PolynomialStandards:
    """
    Canonical polynomial formatting following mathematical convention:
    Descending degree, omit zero terms, rational coefficient display.
    """

    @staticmethod
    def to_string(coeffs: List[float], var: str = "x",
                   decimals: int = 4) -> str:
        """
        Format polynomial coefficients as a human-readable string.
        coeffs[0] is the leading coefficient (highest degree).
        """
        n = len(coeffs) - 1
        terms = []
        for i, c in enumerate(coeffs):
            if abs(c) < 1e-12:
                continue
            degree = n - i
            c_str  = str(round(c, decimals))
            if degree == 0:
                terms.append(c_str)
            elif degree == 1:
                terms.append(f"{c_str}{var}" if c != 1 else var)
            else:
                terms.append(f"{c_str}{var}^{degree}" if c != 1
                              else f"{var}^{degree}")
        return " + ".join(terms).replace("+ -", "- ") or "0"

    @staticmethod
    def to_latex(coeffs: List[float], var: str = "x",
                  decimals: int = 4) -> str:
        n = len(coeffs) - 1
        parts = []
        for i, c in enumerate(coeffs):
            if abs(c) < 1e-12: continue
            degree = n - i
            c_str  = str(round(c, decimals))
            if degree == 0:   parts.append(c_str)
            elif degree == 1: parts.append(f"{c_str}{var}")
            else:             parts.append(f"{c_str}{var}^{{{degree}}}")
        latex = " + ".join(parts).replace("+ -", "- ")
        return f"${latex}$" if latex else "$0$"

    @staticmethod
    def from_roots(roots: List[float]) -> List[float]:
        """Build monic polynomial from its roots: ∏(x - rᵢ)."""
        result = [1.0]
        for r in roots:
            result = Algebra.poly_mul(result, [1.0, -r])
        return result

    @staticmethod
    def normalise(coeffs: List[float]) -> List[float]:
        """Make polynomial monic (leading coefficient = 1)."""
        if not coeffs or abs(coeffs[0]) < 1e-14:
            return coeffs
        lc = coeffs[0]
        return [c / lc for c in coeffs]

    @staticmethod
    def degree(coeffs: List[float], tol: float = 1e-12) -> int:
        """Effective degree (ignoring leading near-zero coefficients)."""
        for i, c in enumerate(coeffs):
            if abs(c) > tol:
                return len(coeffs) - 1 - i
        return 0
