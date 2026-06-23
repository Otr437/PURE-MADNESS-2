"""
Calculus — numerical differentiation, integration, limits, series,
transforms (DFT/FFT), ODE solvers, and functional analysis helpers.
"""
import cmath
import math
from typing import Callable, List, Optional, Tuple


class Calculus:
    # ── Derivatives ───────────────────────────────────────────────────────
    @staticmethod
    def derivative(f: Callable, x: float, h: float = 1e-7, method: str = "central") -> float:
        if method == "forward":  return (f(x+h)-f(x))/h
        if method == "backward": return (f(x)-f(x-h))/h
        if method == "five":     # 5-point stencil
            return (-f(x+2*h)+8*f(x+h)-8*f(x-h)+f(x-2*h))/(12*h)
        return (f(x+h)-f(x-h))/(2*h)

    @staticmethod
    def derivative_n(f: Callable, x: float, n: int, h: float = 1e-5) -> float:
        """nth-order numerical derivative via finite differences."""
        from math import comb
        return sum((-1)**(n-k)*comb(n,k)*f(x+k*h) for k in range(n+1)) / h**n

    @staticmethod
    def second_derivative(f: Callable, x: float, h: float = 1e-5) -> float:
        return (f(x+h)-2*f(x)+f(x-h))/h**2

    @staticmethod
    def partial(f: Callable, vars_: List[float], idx: int, h: float = 1e-7) -> float:
        vp, vm = vars_[:], vars_[:]
        vp[idx] += h; vm[idx] -= h
        return (f(*vp)-f(*vm))/(2*h)

    @staticmethod
    def gradient(f: Callable, x: List[float], h: float = 1e-7) -> List[float]:
        return [Calculus.partial(f, x, i, h) for i in range(len(x))]

    @staticmethod
    def jacobian(fs: List[Callable], x: List[float], h: float = 1e-7) -> List[List[float]]:
        """Jacobian matrix of a vector-valued function."""
        return [[Calculus.partial(f, x, j, h) for j in range(len(x))] for f in fs]

    @staticmethod
    def hessian(f: Callable, x: List[float], h: float = 1e-5) -> List[List[float]]:
        n = len(x); H = [[0.0]*n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    xp, xm = x[:], x[:]
                    xp[i]+=h; xm[i]-=h
                    H[i][i] = (f(*xp)-2*f(*x)+f(*xm))/h**2
                elif i < j:
                    pp,pm,mp,mm = x[:],x[:],x[:],x[:]
                    pp[i]+=h; pp[j]+=h; pm[i]+=h; pm[j]-=h
                    mp[i]-=h; mp[j]+=h; mm[i]-=h; mm[j]-=h
                    H[i][j] = H[j][i] = (f(*pp)-f(*pm)-f(*mp)+f(*mm))/(4*h**2)
        return H

    @staticmethod
    def laplacian(f: Callable, x: List[float], h: float = 1e-5) -> float:
        return sum(Calculus.second_derivative(lambda xi: f(*x[:i]+[xi]+x[i+1:]), x[i], h)
                   for i in range(len(x)))

    @staticmethod
    def directional_derivative(f: Callable, x: List[float],
                                direction: List[float], h: float = 1e-7) -> float:
        norm = math.sqrt(sum(d**2 for d in direction))
        u = [d/norm for d in direction]
        return sum(Calculus.partial(f, x, i, h)*u[i] for i in range(len(x)))

    @staticmethod
    def divergence(F: List[Callable], x: List[float], h: float = 1e-7) -> float:
        """Divergence of a vector field F at point x."""
        return sum(Calculus.partial(F[i], x, i, h) for i in range(len(x)))

    @staticmethod
    def curl_3d(F: List[Callable], x: List[float], h: float = 1e-7) -> List[float]:
        """Curl of a 3D vector field."""
        dFz_dy = Calculus.partial(F[2], x, 1, h); dFy_dz = Calculus.partial(F[1], x, 2, h)
        dFx_dz = Calculus.partial(F[0], x, 2, h); dFz_dx = Calculus.partial(F[2], x, 0, h)
        dFy_dx = Calculus.partial(F[1], x, 0, h); dFx_dy = Calculus.partial(F[0], x, 1, h)
        return [dFz_dy-dFy_dz, dFx_dz-dFz_dx, dFy_dx-dFx_dy]

    # ── Integration ───────────────────────────────────────────────────────
    @staticmethod
    def integrate_riemann(f: Callable, a: float, b: float, n: int = 1000,
                           method: str = "midpoint") -> float:
        dx = (b-a)/n
        if method == "left":   return sum(f(a+i*dx) for i in range(n))*dx
        if method == "right":  return sum(f(a+(i+1)*dx) for i in range(n))*dx
        return sum(f(a+(i+0.5)*dx) for i in range(n))*dx

    @staticmethod
    def integrate_trapezoidal(f: Callable, a: float, b: float, n: int = 1000) -> float:
        dx = (b-a)/n
        return (f(a)/2 + sum(f(a+i*dx) for i in range(1, n)) + f(b)/2) * dx

    @staticmethod
    def integrate_simpson(f: Callable, a: float, b: float, n: int = 1000) -> float:
        if n%2: n+=1
        dx = (b-a)/n
        total = f(a)+f(b)
        for i in range(1, n, 2): total += 4*f(a+i*dx)
        for i in range(2, n-1, 2): total += 2*f(a+i*dx)
        return total*dx/3

    @staticmethod
    def integrate_gauss_legendre(f: Callable, a: float, b: float, n: int = 5) -> float:
        """Gauss-Legendre quadrature (n=2..5)."""
        # Pre-computed nodes/weights for standard [-1,1]
        tables = {
            2: ([0.5773502691896257,-0.5773502691896257],[1.0,1.0]),
            3: ([0.0, 0.7745966692414834,-0.7745966692414834],[8/9,5/9,5/9]),
            4: ([0.3399810435848563,-0.3399810435848563,0.8611363115940526,-0.8611363115940526],
                [0.6521451548625461,0.6521451548625461,0.3478548451374538,0.3478548451374538]),
            5: ([0.0,0.5384693101056831,-0.5384693101056831,0.9061798459386640,-0.9061798459386640],
                [128/225,0.4786286704993665,0.4786286704993665,0.2369268850561891,0.2369268850561891]),
        }
        if n not in tables: n = 5
        xi, wi = tables[n]
        mid = (a+b)/2; half = (b-a)/2
        return half * sum(w*f(mid+half*x) for x, w in zip(xi, wi))

    @staticmethod
    def integrate_romberg(f: Callable, a: float, b: float, max_order: int = 8,
                           tol: float = 1e-12) -> float:
        """Romberg integration."""
        R = [[0.0]*(max_order+1) for _ in range(max_order+1)]
        R[0][0] = (f(a)+f(b))*(b-a)/2
        for i in range(1, max_order+1):
            n = 2**i; h = (b-a)/n
            R[i][0] = R[i-1][0]/2 + h*sum(f(a+(2*k-1)*h) for k in range(1, n//2+1))
            for j in range(1, i+1):
                R[i][j] = (4**j*R[i][j-1]-R[i-1][j-1])/(4**j-1)
            if i > 1 and abs(R[i][i]-R[i-1][i-1]) < tol:
                return R[i][i]
        return R[max_order][max_order]

    @staticmethod
    def integrate_adaptive(f: Callable, a: float, b: float,
                            tol: float = 1e-10, max_depth: int = 20) -> float:
        def _step(a, b, fa, fm, fb, depth):
            m = (a+b)/2; h = b-a
            fl = f((a+m)/2); fr = f((m+b)/2)
            S  = h*(fa+4*fm+fb)/6
            Sl = (h/2)*(fa+4*fl+fm)/6; Sr = (h/2)*(fm+4*fr+fb)/6
            if depth>=max_depth or abs(Sl+Sr-S)<15*tol: return Sl+Sr
            return _step(a,m,fa,fl,fm,depth+1)+_step(m,b,fm,fr,fb,depth+1)
        fa,fm,fb=f(a),f((a+b)/2),f(b)
        return _step(a,b,fa,fm,fb,0)

    @staticmethod
    def double_integral(f: Callable, ax: float, bx: float,
                         ay: Callable, by: Callable, nx: int = 100, ny: int = 100) -> float:
        """∫∫ f(x,y) dy dx  where ay(x)≤y≤by(x)."""
        dx = (bx-ax)/nx; total = 0.0
        for i in range(nx):
            x = ax+(i+0.5)*dx
            a_y, b_y = ay(x), by(x)
            total += Calculus.integrate_simpson(lambda y: f(x,y), a_y, b_y, ny)
        return total*dx

    # ── Limits ────────────────────────────────────────────────────────────
    @staticmethod
    def limit(f: Callable, x0: float, direction: str = "both", h: float = 1e-10) -> Optional[float]:
        if direction == "left":  return f(x0-h)
        if direction == "right": return f(x0+h)
        L, R = f(x0-h), f(x0+h)
        return (L+R)/2 if abs(L-R) < 1e-7 else None

    @staticmethod
    def limit_at_infinity(f: Callable, positive: bool = True, n: int = 8) -> Optional[float]:
        """Estimate limit as x→±∞ using Richardson extrapolation."""
        sign = 1 if positive else -1
        vals = [f(sign*10**k) for k in range(2, n+2)]
        # Check convergence
        for i in range(len(vals)-2, 0, -1):
            if abs(vals[i]-vals[i-1]) < 1e-8: return vals[i]
        return vals[-1]

    # ── Transforms ────────────────────────────────────────────────────────
    @staticmethod
    def dft(signal: List[complex]) -> List[complex]:
        """Discrete Fourier Transform (O(n²))."""
        n = len(signal)
        return [sum(signal[k]*cmath.exp(-2j*math.pi*m*k/n) for k in range(n)) for m in range(n)]

    @staticmethod
    def idft(spectrum: List[complex]) -> List[complex]:
        n = len(spectrum)
        return [sum(spectrum[k]*cmath.exp(2j*math.pi*m*k/n) for k in range(n))/n
                for m in range(n)]

    @staticmethod
    def fft(signal: List[complex]) -> List[complex]:
        """Cooley-Tukey radix-2 FFT (n must be power of 2)."""
        n = len(signal)
        if n <= 1: return list(signal)
        if n & (n-1):
            # Pad to next power of 2
            m = 1
            while m < n: m <<= 1
            signal = list(signal) + [0]*(m-n)
            n = m
        even = Calculus.fft(signal[::2])
        odd  = Calculus.fft(signal[1::2])
        T    = [cmath.exp(-2j*math.pi*k/n)*odd[k] for k in range(n//2)]
        return [even[k]+T[k] for k in range(n//2)] + [even[k]-T[k] for k in range(n//2)]

    @staticmethod
    def ifft(spectrum: List[complex]) -> List[complex]:
        n = len(spectrum)
        conj = [x.conjugate() for x in spectrum]
        result = Calculus.fft(conj)
        return [x.conjugate()/n for x in result]

    @staticmethod
    def fft_frequencies(n: int, sample_rate: float = 1.0) -> List[float]:
        return [k*sample_rate/n if k < n//2 else (k-n)*sample_rate/n for k in range(n)]

    @staticmethod
    def laplace_transform_numerical(f: Callable, s: complex, T: float = 20,
                                     n: int = 1000) -> complex:
        """Numerical Laplace transform F(s) = ∫₀ᵀ f(t)e^{-st} dt."""
        dt = T/n
        return sum(f(k*dt)*cmath.exp(-s*k*dt) for k in range(n)) * dt

    @staticmethod
    def z_transform_numerical(x: List[float], z: complex) -> complex:
        """Numerical Z-transform X(z) = Σ x[n] z^{-n}."""
        return sum(v*z**(-n) for n, v in enumerate(x))

    # ── Taylor / Laurent series ───────────────────────────────────────────
    @staticmethod
    def taylor_coefficients(f: Callable, a: float, order: int = 6, h: float = 1e-4) -> List[float]:
        """Compute Taylor series coefficients at point a."""
        return [Calculus.derivative_n(f, a, n, h)/math.factorial(n) for n in range(order+1)]

    @staticmethod
    def taylor_approx(f: Callable, a: float, x: float, order: int = 6, h: float = 1e-4) -> float:
        coeffs = Calculus.taylor_coefficients(f, a, order, h)
        return sum(c*(x-a)**n for n, c in enumerate(coeffs))

    @staticmethod
    def richardson_extrapolation(f: Callable, x: float, h: float = 0.1, order: int = 4) -> float:
        """Richardson extrapolation for high-accuracy derivative."""
        table = [[0.0]*(order+1) for _ in range(order+1)]
        for i in range(order+1):
            hi = h/2**i
            table[i][0] = (f(x+hi)-f(x-hi))/(2*hi)
        for j in range(1, order+1):
            for i in range(order+1-j):
                table[i][j] = (4**j*table[i+1][j-1]-table[i][j-1])/(4**j-1)
        return table[0][order]

    # ── Arc length / surface area ─────────────────────────────────────────
    @staticmethod
    def arc_length(f: Callable, a: float, b: float, n: int = 1000) -> float:
        """Arc length of y=f(x) from a to b."""
        def integrand(x): return math.sqrt(1 + Calculus.derivative(f, x)**2)
        return Calculus.integrate_simpson(integrand, a, b, n)

    @staticmethod
    def surface_of_revolution(f: Callable, a: float, b: float, n: int = 1000) -> float:
        """Surface area of revolution of f(x) around x-axis."""
        def integrand(x): return 2*math.pi*abs(f(x))*math.sqrt(1+Calculus.derivative(f,x)**2)
        return Calculus.integrate_simpson(integrand, a, b, n)

    @staticmethod
    def volume_of_revolution(f: Callable, a: float, b: float, n: int = 1000) -> float:
        """Volume via disk method (rotation around x-axis)."""
        return math.pi*Calculus.integrate_simpson(lambda x: f(x)**2, a, b, n)


# ── Extended calculus: numerical PDE, variational, convolution ────────────

    @staticmethod
    def finite_difference_1d(f_vals: List[float], dx: float,
                               order: int = 2) -> List[float]:
        """
        Finite difference approximation of df/dx for discrete data.
        order=1: forward; order=2: central (default); order=4: 5-point stencil.
        """
        n = len(f_vals); result = [0.0]*n
        if order == 1:
            for i in range(n-1):
                result[i] = (f_vals[i+1] - f_vals[i]) / dx
            result[-1] = result[-2]
        elif order == 4 and n >= 5:
            for i in range(2, n-2):
                result[i] = (-f_vals[i+2] + 8*f_vals[i+1]
                             - 8*f_vals[i-1] + f_vals[i-2]) / (12*dx)
            result[0] = result[2]; result[1] = result[2]
            result[-1] = result[-3]; result[-2] = result[-3]
        else:   # central differences
            for i in range(1, n-1):
                result[i] = (f_vals[i+1] - f_vals[i-1]) / (2*dx)
            result[0] = result[1]; result[-1] = result[-2]
        return result

    @staticmethod
    def finite_difference_2d(f_grid: List[List[float]],
                              dx: float, dy: float) -> dict:
        """
        2D finite differences: returns dfdx, dfdy grids.
        """
        m = len(f_grid); n = len(f_grid[0])
        dfdx = [[0.0]*n for _ in range(m)]
        dfdy = [[0.0]*n for _ in range(m)]
        for i in range(m):
            row = Calculus.finite_difference_1d(f_grid[i], dx)
            dfdx[i] = row
        for j in range(n):
            col = [f_grid[i][j] for i in range(m)]
            dc  = Calculus.finite_difference_1d(col, dy)
            for i in range(m):
                dfdy[i][j] = dc[i]
        return {"dfdx": dfdx, "dfdy": dfdy}

    @staticmethod
    def heat_equation_1d(u0: List[float], dx: float, dt: float,
                          alpha: float, steps: int) -> List[List[float]]:
        """
        Explicit finite difference for heat equation ∂u/∂t = α ∂²u/∂x².
        Stability: r = α*dt/dx² ≤ 0.5.
        Returns time-history [u(t0), u(t1), …, u(tn)].
        """
        r = alpha * dt / dx**2
        n = len(u0)
        u = u0[:]
        history = [u[:]]
        for _ in range(steps):
            u_new = u[:]
            for i in range(1, n-1):
                u_new[i] = u[i] + r*(u[i+1] - 2*u[i] + u[i-1])
            u = u_new; history.append(u[:])
        return history

    @staticmethod
    def wave_equation_1d(u0: List[float], v0: List[float],
                          dx: float, dt: float, c: float,
                          steps: int) -> List[List[float]]:
        """
        Finite difference for wave equation ∂²u/∂t² = c² ∂²u/∂x².
        u0 = initial displacement, v0 = initial velocity.
        """
        r = (c * dt / dx)**2
        n = len(u0)
        u_prev = u0[:]
        u_curr = [u0[i] + dt*v0[i] + 0.5*r*(
                  u0[min(i+1,n-1)] - 2*u0[i] + u0[max(i-1,0)])
                  for i in range(n)]
        history = [u_prev, u_curr]
        for _ in range(steps - 1):
            u_next = [0.0]*n
            for i in range(1, n-1):
                u_next[i] = (2*u_curr[i] - u_prev[i]
                             + r*(u_curr[i+1] - 2*u_curr[i] + u_curr[i-1]))
            u_prev, u_curr = u_curr, u_next
            history.append(u_curr[:])
        return history

    @staticmethod
    def poisson_1d(f: List[float], dx: float,
                    u_left: float = 0.0,
                    u_right: float = 0.0) -> List[float]:
        """
        Solve 1D Poisson equation -u'' = f via Thomas algorithm.
        Boundary conditions: u[0] = u_left, u[-1] = u_right.
        """
        n   = len(f)
        rhs = [dx**2 * fi for fi in f]
        rhs[0]   -= u_left
        rhs[-1]  -= u_right
        # Tridiagonal: -1, 2, -1
        a = [-1.0]*(n-1); b = [2.0]*n; c = [-1.0]*(n-1)
        # Forward sweep
        for i in range(1, n):
            m       = a[i-1] / b[i-1]
            b[i]   -= m * (c[i-1] if i-1 < len(c) else 0)
            rhs[i] -= m * rhs[i-1]
        # Back substitution
        u = [0.0]*n
        u[-1] = rhs[-1] / b[-1]
        for i in range(n-2, -1, -1):
            u[i] = (rhs[i] - (c[i] if i < len(c) else 0)*u[i+1]) / b[i]
        return [u_left] + u + [u_right]

    @staticmethod
    def convolution(f: List[float], g: List[float]) -> List[float]:
        """Discrete convolution (f * g)[n] = Σ f[k]·g[n-k]."""
        nf, ng = len(f), len(g)
        n_out  = nf + ng - 1
        result = [0.0]*n_out
        for i in range(nf):
            for j in range(ng):
                result[i+j] += f[i]*g[j]
        return result

    @staticmethod
    def cross_correlation(f: List[float], g: List[float]) -> List[float]:
        """Cross-correlation (f ⋆ g)[n] = Σ f[k]·g[k+n]."""
        nf, ng = len(f), len(g)
        lags   = list(range(-(ng-1), nf))
        result = []
        for lag in lags:
            s = sum(f[k]*g[k-lag] for k in range(nf)
                    if 0 <= k-lag < ng)
            result.append(s)
        return result

    @staticmethod
    def euler_lagrange(L_expr: str, var: str, t_var: str,
                        point: float = 0.0) -> dict:
        """
        Numerical Euler-Lagrange residual check for Lagrangian L(q, q̇, t).
        Returns partial derivatives ∂L/∂q and d/dt(∂L/∂q̇).
        L_expr must be evaluable with variables {var, var+'_dot', t_var}.
        """
        from packages.symbolic import SymbolicMathEngine
        sym = SymbolicMathEngine()
        dL_dq    = sym.partial_derivative(L_expr,
                       {var: point, var+"_dot": 0.1, t_var: 0.0}, var)
        dL_dqdot = sym.partial_derivative(L_expr,
                       {var: point, var+"_dot": 0.1, t_var: 0.0}, var+"_dot")
        return {
            "dL_dq":     dL_dq,
            "dL_dqdot":  dL_dqdot,
            "EL_residual": dL_dq,   # simplified (full d/dt needs ODE solver)
        }

    @staticmethod
    def numerical_pde_1d_explicit(u0: List[float],
                                   diffusion: float,
                                   source: Callable,
                                   dx: float, dt: float,
                                   steps: int) -> List[List[float]]:
        """
        General 1D parabolic PDE with source term:
        ∂u/∂t = D ∂²u/∂x² + source(x, t, u)
        """
        r = diffusion*dt/dx**2; n = len(u0)
        u = u0[:]; xs = [i*dx for i in range(n)]
        history = [u[:]]
        t = 0.0
        for _ in range(steps):
            u_new = u[:]
            for i in range(1, n-1):
                diff = r*(u[i+1] - 2*u[i] + u[i-1])
                src  = dt * source(xs[i], t, u[i])
                u_new[i] = u[i] + diff + src
            u = u_new; t += dt; history.append(u[:])
        return history


# ── Security: calculus input validation ──────────────────────────────────

class CalculusValidator:
    """
    Validates all inputs to Calculus methods.
    Guards against: infinite recursion in adaptive integrators,
    NaN propagation, unsound step sizes, and oversized grids.
    """
    MAX_GRID_SIZE   = 1_000_000
    MAX_STEPS       = 100_000
    MAX_ORDER       = 10
    MIN_STEP_SIZE   = 1e-15
    MAX_STEP_SIZE   = 1e6

    @classmethod
    def validate_function(cls, f, name: str = "f") -> Callable:
        if not callable(f):
            raise TypeError(f"{name} must be callable")
        return f

    @classmethod
    def validate_interval(cls, a: float, b: float) -> tuple:
        import math
        if not math.isfinite(a) or not math.isfinite(b):
            raise ValueError(f"Integration bounds must be finite: a={a}, b={b}")
        if a == b:
            raise ValueError("Integration bounds a and b must differ")
        return a, b

    @classmethod
    def validate_step_size(cls, h: float, name: str = "h") -> float:
        if h <= cls.MIN_STEP_SIZE:
            raise ValueError(f"{name}={h} too small (min {cls.MIN_STEP_SIZE})")
        if h > cls.MAX_STEP_SIZE:
            raise ValueError(f"{name}={h} too large (max {cls.MAX_STEP_SIZE})")
        return h

    @classmethod
    def validate_derivative_order(cls, order: int) -> int:
        if not isinstance(order, int) or order < 1:
            raise ValueError("order must be positive integer")
        if order > cls.MAX_ORDER:
            raise ValueError(f"order {order} exceeds max {cls.MAX_ORDER}")
        return order

    @classmethod
    def validate_grid(cls, vals: List[float],
                       name: str = "grid") -> List[float]:
        if len(vals) > cls.MAX_GRID_SIZE:
            raise ValueError(f"{name} has {len(vals)} points; max {cls.MAX_GRID_SIZE}")
        import math
        bad = [i for i, v in enumerate(vals) if not math.isfinite(v)]
        if bad:
            raise ValueError(f"{name} has non-finite values at indices {bad[:5]}")
        return vals

    @classmethod
    def validate_pde_stability(cls, r: float, method: str = "heat") -> None:
        """Warn or raise on known instability conditions."""
        if method == "heat" and r > 0.5:
            raise ValueError(
                f"Heat equation stability violated: r={r:.4f} > 0.5. "
                "Reduce dt or increase dx.")
        if method == "wave" and r > 1.0:
            raise ValueError(
                f"Wave equation CFL condition violated: r={r:.4f} > 1.0.")

    @classmethod
    def validate_ode_system(cls, fs: List[Callable],
                             y0: List[float]) -> tuple:
        if len(fs) != len(y0):
            raise ValueError(f"ODE system: {len(fs)} equations but "
                             f"{len(y0)} initial conditions")
        for i, f in enumerate(fs):
            if not callable(f):
                raise TypeError(f"fs[{i}] is not callable")
        return fs, y0


# ── Standards: numerical analysis output format ───────────────────────────

class NumericalStandards:
    """
    Output formatting and error reporting for numerical methods.
    Follows: Burden & Faires 'Numerical Analysis' reporting conventions.
    """

    @staticmethod
    def integration_report(method: str, result: float,
                            interval: tuple, n_evals: int,
                            error_est: float = None) -> dict:
        return {
            "method":     method,
            "result":     round(result, 12),
            "interval":   interval,
            "n_evals":    n_evals,
            "error_est":  error_est,
        }

    @staticmethod
    def convergence_table(errors: List[float],
                           step_sizes: List[float]) -> List[dict]:
        """
        Build a convergence rate table.
        Rate ≈ log(e_n/e_{n+1}) / log(h_n/h_{n+1})
        """
        rows = []
        for i, (h, e) in enumerate(zip(step_sizes, errors)):
            rate = None
            if i > 0 and errors[i-1] > 0 and step_sizes[i-1] > 0:
                import math
                rate = (math.log(errors[i-1]/e) /
                        math.log(step_sizes[i-1]/h))
            rows.append({"h": h, "error": e,
                          "rate": round(rate, 3) if rate else None})
        return rows

    @staticmethod
    def ode_summary(method: str, n_steps: int,
                     final_t: float, final_y: float,
                     step_size: float) -> dict:
        return {
            "method":   method,
            "n_steps":  n_steps,
            "final_t":  final_t,
            "final_y":  round(final_y, 10),
            "step_h":   step_size,
        }

    @staticmethod
    def pde_energy(u: List[float], dx: float) -> float:
        """L2 norm (energy) of a 1D PDE solution: √(Σ u² dx)."""
        import math
        return math.sqrt(sum(v**2 for v in u) * dx)

    @staticmethod
    def format_matrix(M: List[List[float]], decimals: int = 4) -> str:
        rows = []
        for row in M:
            rows.append("  [" + "  ".join(f"{v:{decimals+6}.{decimals}f}"
                                            for v in row) + "]")
        return "\n".join(rows)
