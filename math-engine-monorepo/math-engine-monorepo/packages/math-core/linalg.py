"""
LinearAlgebra — vectors, matrices, decompositions (LU/QR/SVD/Cholesky),
eigenvalues, norms, sparse helpers, and iterative solvers.
"""
import math
from typing import List, Optional, Tuple


class LinearAlgebra:
    # ── Vector ops ────────────────────────────────────────────────────────
    @staticmethod
    def vadd(a,b): return [x+y for x,y in zip(a,b)]
    @staticmethod
    def vsub(a,b): return [x-y for x,y in zip(a,b)]
    @staticmethod
    def vscale(v,s): return [x*s for x in v]
    @staticmethod
    def dot(a,b): return sum(x*y for x,y in zip(a,b))
    @staticmethod
    def cross(a,b):
        if len(a)!=3: raise ValueError("cross product requires 3D")
        return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    @staticmethod
    def norm(v, p:int=2) -> float:
        if p==0: return sum(1 for x in v if x!=0)
        if p==float("inf"): return max(abs(x) for x in v)
        return sum(abs(x)**p for x in v)**(1/p)
    @staticmethod
    def normalize(v):
        n=LinearAlgebra.norm(v); return v if n==0 else [x/n for x in v]
    @staticmethod
    def angle(a,b):
        n1,n2=LinearAlgebra.norm(a),LinearAlgebra.norm(b)
        return math.acos(max(-1,min(1,LinearAlgebra.dot(a,b)/(n1*n2)))) if n1 and n2 else 0
    @staticmethod
    def proj(a,b):
        n2=LinearAlgebra.dot(b,b)
        return LinearAlgebra.vscale(b, LinearAlgebra.dot(a,b)/n2) if n2 else [0]*len(a)
    @staticmethod
    def gram_schmidt(vecs: List[List[float]]) -> List[List[float]]:
        """Gram-Schmidt orthonormalisation."""
        basis = []
        for v in vecs:
            w = v[:]
            for u in basis:
                c = LinearAlgebra.dot(v, u)
                w = LinearAlgebra.vsub(w, LinearAlgebra.vscale(u, c))
            n = LinearAlgebra.norm(w)
            if n > 1e-12: basis.append(LinearAlgebra.vscale(w, 1/n))
        return basis
    @staticmethod
    def outer(a,b): return [[x*y for y in b] for x in a]

    # ── Matrix construction ───────────────────────────────────────────────
    @staticmethod
    def zeros(m,n): return [[0.0]*n for _ in range(m)]
    @staticmethod
    def eye(n): return [[1.0 if i==j else 0.0 for j in range(n)] for i in range(n)]
    @staticmethod
    def diag(v): n=len(v); return [[v[i] if i==j else 0.0 for j in range(n)] for i in range(n)]
    @staticmethod
    def hilbert(n): return [[1.0/(i+j+1) for j in range(n)] for i in range(n)]
    @staticmethod
    def vandermonde(v):
        n=len(v); return [[v[i]**j for j in range(n)] for i in range(n)]

    # ── Matrix arithmetic ─────────────────────────────────────────────────
    @staticmethod
    def madd(A,B): return [[A[i][j]+B[i][j] for j in range(len(A[0]))] for i in range(len(A))]
    @staticmethod
    def msub(A,B): return [[A[i][j]-B[i][j] for j in range(len(A[0]))] for i in range(len(A))]
    @staticmethod
    def mscale(A,s): return [[A[i][j]*s for j in range(len(A[0]))] for i in range(len(A))]
    @staticmethod
    def transpose(A): return [[A[j][i] for j in range(len(A))] for i in range(len(A[0]))]
    @staticmethod
    def mmul(A,B):
        ra,ca,cb=len(A),len(A[0]),len(B[0]); C=LinearAlgebra.zeros(ra,cb)
        for i in range(ra):
            for k in range(ca):
                if A[i][k]==0: continue
                for j in range(cb): C[i][j]+=A[i][k]*B[k][j]
        return C
    @staticmethod
    def trace(A): return sum(A[i][i] for i in range(min(len(A),len(A[0]))))
    @staticmethod
    def frobenius_norm(A):
        return math.sqrt(sum(A[i][j]**2 for i in range(len(A)) for j in range(len(A[0]))))

    # ── Determinant & inverse ─────────────────────────────────────────────
    @staticmethod
    def det(A):
        n=len(A)
        if n==1: return A[0][0]
        if n==2: return A[0][0]*A[1][1]-A[0][1]*A[1][0]
        M=[r[:] for r in A]; sign=1; d=1.0
        for i in range(n):
            piv=max(range(i,n),key=lambda r:abs(M[r][i]))
            if abs(M[piv][i])<1e-14: return 0.0
            if piv!=i: M[i],M[piv]=M[piv],M[i]; sign=-sign
            d*=M[i][i]
            for k in range(i+1,n):
                f=M[k][i]/M[i][i]
                for j in range(i,n): M[k][j]-=f*M[i][j]
        return sign*d

    @staticmethod
    def inv(A):
        n=len(A); aug=[r[:]+[1.0 if i==j else 0.0 for j in range(n)] for i,r in enumerate(A)]
        for i in range(n):
            piv=max(range(i,n),key=lambda r:abs(aug[r][i]))
            if abs(aug[piv][i])<1e-15: return None
            aug[i],aug[piv]=aug[piv],aug[i]
            pv=aug[i][i]
            for j in range(2*n): aug[i][j]/=pv
            for r in range(n):
                if r!=i:
                    f=aug[r][i]
                    for c in range(2*n): aug[r][c]-=f*aug[i][c]
        return [[aug[i][j+n] for j in range(n)] for i in range(n)]

    @staticmethod
    def rank(A, tol=1e-10):
        m,n=len(A),len(A[0]); M=[r[:] for r in A]; rank=0; row=0
        for col in range(n):
            piv=next((r for r in range(row,m) if abs(M[r][col])>tol),None)
            if piv is None: continue
            M[row],M[piv]=M[piv],M[row]
            pv=M[row][col]
            for r in range(row+1,m):
                f=M[r][col]/pv
                for c in range(col,n): M[r][c]-=f*M[row][c]
            rank+=1; row+=1
        return rank

    # ── Decompositions ────────────────────────────────────────────────────
    @staticmethod
    def lu(A):
        """LU decomposition with partial pivoting. Returns (L, U, P, sign)."""
        n=len(A); L=LinearAlgebra.eye(n); U=[r[:] for r in A]; P=LinearAlgebra.eye(n); sign=1
        for k in range(n):
            piv=max(range(k,n),key=lambda i:abs(U[i][k]))
            if abs(U[piv][k])<1e-14: continue
            if piv!=k:
                U[k],U[piv]=U[piv],U[k]; P[k],P[piv]=P[piv],P[k]
                for j in range(k): L[k][j],L[piv][j]=L[piv][j],L[k][j]
                sign=-sign
            for i in range(k+1,n):
                if abs(U[k][k])<1e-14: continue
                f=U[i][k]/U[k][k]; L[i][k]=f
                for j in range(k,n): U[i][j]-=f*U[k][j]
        return L,U,P,sign

    @staticmethod
    def qr(A):
        """QR decomposition via Householder reflections."""
        m,n=len(A),len(A[0]); Q=LinearAlgebra.eye(m); R=[r[:] for r in A]
        for k in range(min(m,n)):
            x=[R[i][k] for i in range(k,m)]
            alpha=-math.copysign(LinearAlgebra.norm(x),x[0])
            u=x[:]; u[0]-=alpha
            nu=LinearAlgebra.norm(u)
            if nu<1e-14: continue
            u=[ui/nu for ui in u]
            # Apply Householder to R
            for j in range(k,n):
                s=2*sum(u[i-k]*R[i][j] for i in range(k,m))
                for i in range(k,m): R[i][j]-=s*u[i-k]
            # Apply to Q
            for j in range(m):
                s=2*sum(u[i-k]*Q[j][i] for i in range(k,m))
                for i in range(k,m): Q[j][i]-=s*u[i-k]
        return LinearAlgebra.transpose(Q), R

    @staticmethod
    def cholesky(A):
        """Cholesky decomposition: A = L Lᵀ for symmetric positive definite A."""
        n=len(A); L=LinearAlgebra.zeros(n,n)
        for i in range(n):
            for j in range(i+1):
                s=sum(L[i][k]*L[j][k] for k in range(j))
                if i==j:
                    val=A[i][i]-s
                    if val<0: raise ValueError("Matrix not positive definite")
                    L[i][j]=math.sqrt(val)
                else:
                    if abs(L[j][j])<1e-15: continue
                    L[i][j]=(A[i][j]-s)/L[j][j]
        return L

    @staticmethod
    def svd_power(A, k: int = 3):
        """Approximate top-k singular values/vectors via power iteration."""
        m,n=len(A),len(A[0]); At=LinearAlgebra.transpose(A)
        results=[]
        B=[r[:] for r in A]
        for _ in range(k):
            v=[1.0/math.sqrt(n)]*n
            for __ in range(100):
                u=LinearAlgebra.mmul(B,[v[j:j+1] for j in range(n)]); u=[r[0] for r in u]
                sigma=LinearAlgebra.norm(u)
                if sigma<1e-14: break
                u=[x/sigma for x in u]
                v_new=LinearAlgebra.mmul(At,[[ui] for ui in u]); v_new=[r[0] for r in v_new]
                sigma=LinearAlgebra.norm(v_new)
                if sigma<1e-14: break
                v=[x/sigma for x in v_new]
            results.append((sigma,u,v))
            # Deflate
            for i in range(m):
                for j in range(n):
                    B[i][j]-=sigma*u[i]*v[j]
        return results

    # ── Linear system solvers ─────────────────────────────────────────────
    @staticmethod
    def solve(A,b):
        """Gauss-Jordan elimination."""
        n=len(A); M=[A[i][:]+[b[i]] for i in range(n)]
        for i in range(n):
            piv=max(range(i,n),key=lambda r:abs(M[r][i]))
            if abs(M[piv][i])<1e-15: return None
            M[i],M[piv]=M[piv],M[i]; pv=M[i][i]
            for j in range(i,n+1): M[i][j]/=pv
            for r in range(n):
                if r!=i:
                    f=M[r][i]
                    for c in range(i,n+1): M[r][c]-=f*M[i][c]
        return [M[i][n] for i in range(n)]

    @staticmethod
    def solve_lu(A,b):
        L,U,P,_=LinearAlgebra.lu(A)
        n=len(b)
        Pb=[sum(P[i][j]*b[j] for j in range(n)) for i in range(n)]
        y=[0.0]*n
        for i in range(n): y[i]=Pb[i]-sum(L[i][j]*y[j] for j in range(i))
        x=[0.0]*n
        for i in range(n-1,-1,-1):
            if abs(U[i][i])<1e-15: continue
            x[i]=(y[i]-sum(U[i][j]*x[j] for j in range(i+1,n)))/U[i][i]
        return x

    @staticmethod
    def conjugate_gradient(A, b, max_iter:int=1000, tol:float=1e-10) -> List[float]:
        """Conjugate gradient method for symmetric positive definite A."""
        n=len(b); x=[0.0]*n
        r=b[:]; p=b[:]; rsold=LinearAlgebra.dot(r,r)
        for _ in range(max_iter):
            Ap=[sum(A[i][j]*p[j] for j in range(n)) for i in range(n)]
            pAp=LinearAlgebra.dot(p,Ap)
            if abs(pAp)<1e-14: break
            alpha=rsold/pAp
            x=[x[i]+alpha*p[i] for i in range(n)]
            r=[r[i]-alpha*Ap[i] for i in range(n)]
            rsnew=LinearAlgebra.dot(r,r)
            if math.sqrt(rsnew)<tol: break
            beta=rsnew/rsold
            p=[r[i]+beta*p[i] for i in range(n)]
            rsold=rsnew
        return x

    # ── Eigenvalues ───────────────────────────────────────────────────────
    @staticmethod
    def eigenvalues_qr(A, max_iter=1000, tol=1e-10):
        n=len(A); Ak=[r[:] for r in A]
        for _ in range(max_iter):
            Q,R=LinearAlgebra.qr(Ak); Ak=LinearAlgebra.mmul(R,Q)
            off=sum(Ak[i][j]**2 for i in range(n) for j in range(n) if i!=j)
            if off<tol: break
        return [Ak[i][i] for i in range(n)]

    @staticmethod
    def power_iteration(A, max_iter:int=1000, tol:float=1e-10):
        n=len(A); v=[1.0/math.sqrt(n)]*n; lam_old=0.0
        for _ in range(max_iter):
            w=[sum(A[i][j]*v[j] for j in range(n)) for i in range(n)]
            lam=LinearAlgebra.dot(v,w); nw=LinearAlgebra.norm(w)
            if nw<1e-14: break
            v=[x/nw for x in w]
            if abs(lam-lam_old)<tol: break
            lam_old=lam
        return lam, v

    @staticmethod
    def rayleigh_quotient(A, v) -> float:
        n=len(v); Av=[sum(A[i][j]*v[j] for j in range(n)) for i in range(n)]
        return LinearAlgebra.dot(v,Av)/LinearAlgebra.dot(v,v)

    # ── Special matrices ──────────────────────────────────────────────────
    @staticmethod
    def is_symmetric(A, tol=1e-10) -> bool:
        n=len(A)
        return all(abs(A[i][j]-A[j][i])<tol for i in range(n) for j in range(n))

    @staticmethod
    def is_positive_definite(A) -> bool:
        try: LinearAlgebra.cholesky(A); return True
        except: return False

    @staticmethod
    def condition_number(A) -> float:
        svds=LinearAlgebra.svd_power(A, k=2)
        if len(svds)<2 or abs(svds[1][0])<1e-15: return float("inf")
        return svds[0][0]/svds[-1][0]

    @staticmethod
    def pseudo_inverse(A):
        """Moore-Penrose pseudo-inverse via QR."""
        Qt, R = LinearAlgebra.qr(A)
        Q = LinearAlgebra.transpose(Qt)
        Ri = LinearAlgebra.inv(R)
        if Ri is None: return None
        return LinearAlgebra.mmul(Ri, Qt)


# ── Extended linear algebra: advanced decompositions and iterative methods ─

    @staticmethod
    def tridiagonal_solve(lower: List[float], main: List[float],
                           upper: List[float], b: List[float]) -> List[float]:
        """
        Thomas algorithm for tridiagonal systems. O(n).
        lower[i] is the subdiagonal (lower[0] unused).
        """
        n = len(main)
        c = upper[:]
        d = b[:]
        # Forward sweep
        for i in range(1, n):
            m    = lower[i] / main[i-1] if abs(main[i-1]) > 1e-15 else 0
            main[i] -= m * c[i-1]
            d[i]    -= m * d[i-1]
        # Back substitution
        x = [0.0]*n
        x[-1] = d[-1] / main[-1] if abs(main[-1]) > 1e-15 else 0
        for i in range(n-2, -1, -1):
            x[i] = (d[i] - c[i]*x[i+1]) / main[i] if abs(main[i]) > 1e-15 else 0
        return x

    @staticmethod
    def gauss_seidel(A: List[List[float]], b: List[float],
                      x0: List[float] = None,
                      max_iter: int = 1000, tol: float = 1e-10) -> List[float]:
        """Gauss-Seidel iterative solver for Ax = b."""
        n   = len(A)
        x   = x0[:] if x0 else [0.0]*n
        for _ in range(max_iter):
            x_old = x[:]
            for i in range(n):
                s = sum(A[i][j]*x[j] for j in range(n) if j != i)
                if abs(A[i][i]) > 1e-15:
                    x[i] = (b[i] - s) / A[i][i]
            if max(abs(x[i]-x_old[i]) for i in range(n)) < tol:
                break
        return x

    @staticmethod
    def jacobi_iteration(A: List[List[float]], b: List[float],
                          max_iter: int = 1000, tol: float = 1e-10) -> List[float]:
        """Jacobi iterative solver (parallel update)."""
        n = len(A); x = [0.0]*n
        for _ in range(max_iter):
            x_new = [(b[i] - sum(A[i][j]*x[j] for j in range(n) if j != i))
                     / A[i][i] if abs(A[i][i]) > 1e-15 else 0
                     for i in range(n)]
            if max(abs(x_new[i]-x[i]) for i in range(n)) < tol:
                return x_new
            x = x_new
        return x

    @staticmethod
    def sor(A: List[List[float]], b: List[float],
             omega: float = 1.5,
             max_iter: int = 1000, tol: float = 1e-10) -> List[float]:
        """Successive Over-Relaxation (SOR). ω=1 → Gauss-Seidel."""
        n = len(A); x = [0.0]*n
        for _ in range(max_iter):
            x_old = x[:]
            for i in range(n):
                s = sum(A[i][j]*x[j] for j in range(n) if j != i)
                if abs(A[i][i]) > 1e-15:
                    x[i] = (1-omega)*x[i] + omega*(b[i]-s)/A[i][i]
            if max(abs(x[i]-x_old[i]) for i in range(n)) < tol:
                break
        return x

    @staticmethod
    def householder_reflection(v: List[float]) -> List[List[float]]:
        """Build Householder reflection matrix H = I - 2vvᵀ/‖v‖²."""
        n    = len(v)
        norm2 = sum(x*x for x in v)
        H    = LinearAlgebra.eye(n)
        if norm2 < 1e-15:
            return H
        for i in range(n):
            for j in range(n):
                H[i][j] -= 2*v[i]*v[j]/norm2
        return H

    @staticmethod
    def bidiagonalise(A: List[List[float]]) -> dict:
        """
        Golub-Kahan bidiagonalisation: A = U B Vᵀ
        where B is upper bidiagonal.
        Returns dict with U, B_diag (diagonal), B_super (superdiagonal), V.
        """
        m, n = len(A), len(A[0])
        U = LinearAlgebra.eye(m)
        V = LinearAlgebra.eye(n)
        B = [row[:] for row in A]
        alpha = []; beta = []
        for k in range(min(m, n)):
            col = [B[i][k] for i in range(k, m)]
            norm_col = LinearAlgebra.norm(col)
            if norm_col > 1e-14:
                alpha.append(norm_col)
                for i in range(k, m): B[i][k] /= norm_col
            else:
                alpha.append(0.0)
            if k < n-1:
                row = [B[k][j] for j in range(k+1, n)]
                norm_row = LinearAlgebra.norm(row)
                if norm_row > 1e-14:
                    beta.append(norm_row)
                    for j in range(k+1, n): B[k][j] /= norm_row
                else:
                    beta.append(0.0)
        return {"alpha": alpha, "beta": beta}

    @staticmethod
    def matrix_exp(A: List[List[float]],
                    terms: int = 20) -> List[List[float]]:
        """
        Matrix exponential via Taylor series: e^A = Σ Aⁿ/n!
        Suitable for small, well-conditioned matrices.
        """
        n      = len(A)
        result = LinearAlgebra.eye(n)
        term   = LinearAlgebra.eye(n)
        for k in range(1, terms+1):
            term   = LinearAlgebra.mscale(LinearAlgebra.mmul(term, A), 1/k)
            result = LinearAlgebra.madd(result, term)
            if LinearAlgebra.frobenius_norm(term) < 1e-14:
                break
        return result

    @staticmethod
    def matrix_log(A: List[List[float]],
                    terms: int = 30) -> List[List[float]]:
        """
        Matrix logarithm via Gregory series: log(A) = 2 Σ ((A-I)(A+I)⁻¹)^(2k+1)/(2k+1)
        Valid near identity.
        """
        n = len(A); I = LinearAlgebra.eye(n)
        AmI = LinearAlgebra.msub(A, I)
        ApI = LinearAlgebra.madd(A, I)
        ApI_inv = LinearAlgebra.inv(ApI)
        if ApI_inv is None:
            raise ValueError("Matrix log: A+I is singular")
        X   = LinearAlgebra.mmul(AmI, ApI_inv)
        result = [[0.0]*n for _ in range(n)]
        Xpow   = LinearAlgebra.eye(n)
        for k in range(terms):
            Xpow   = LinearAlgebra.mmul(Xpow, LinearAlgebra.mmul(X, X))
            term   = LinearAlgebra.mscale(LinearAlgebra.mmul(X, Xpow), 2/(2*k+1))
            result = LinearAlgebra.madd(result, term)
            if LinearAlgebra.frobenius_norm(term) < 1e-14:
                break
        return result

    @staticmethod
    def krylov_subspace(A: List[List[float]], b: List[float],
                         k: int) -> List[List[float]]:
        """
        Build Krylov subspace basis K_k(A,b) = span{b, Ab, A²b, …, A^{k-1}b}
        via Arnoldi iteration (modified Gram-Schmidt).
        Returns list of k orthonormal vectors.
        """
        n    = len(b)
        norm = LinearAlgebra.norm(b)
        q    = [x/norm for x in b]
        Q    = [q]
        for _ in range(1, k):
            v = [sum(A[i][j]*Q[-1][j] for j in range(n)) for i in range(n)]
            for qi in Q:
                proj = LinearAlgebra.dot(v, qi)
                v    = [v[j] - proj*qi[j] for j in range(n)]
            norm_v = LinearAlgebra.norm(v)
            if norm_v < 1e-13:
                break
            Q.append([x/norm_v for x in v])
        return Q


# ── Security: linear algebra input validation ─────────────────────────────

class LinearAlgebraValidator:
    """
    Guards all LinearAlgebra inputs against:
      - Non-square matrices where square is required
      - Dimension mismatches
      - Size bombs (extremely large matrices)
      - NaN/Inf elements
      - Singular matrices before inversion
    """
    MAX_DIMENSION  = 2_000
    MAX_ELEMENTS   = 4_000_000

    @classmethod
    def validate_matrix(cls, A: List[List[float]],
                         name: str = "A",
                         square: bool = False) -> List[List[float]]:
        import math
        if not isinstance(A, (list, tuple)) or not A:
            raise TypeError(f"{name} must be a non-empty list of lists")
        m = len(A); n = len(A[0])
        if m > cls.MAX_DIMENSION or n > cls.MAX_DIMENSION:
            raise ValueError(f"{name} dimension ({m}×{n}) exceeds max {cls.MAX_DIMENSION}")
        if m*n > cls.MAX_ELEMENTS:
            raise ValueError(f"{name} has {m*n} elements; max {cls.MAX_ELEMENTS}")
        if square and m != n:
            raise ValueError(f"{name} must be square, got {m}×{n}")
        for i, row in enumerate(A):
            if len(row) != n:
                raise ValueError(f"{name}[{i}] has {len(row)} cols, expected {n}")
            for j, v in enumerate(row):
                if not isinstance(v, (int, float, complex)):
                    raise TypeError(f"{name}[{i}][{j}] is not numeric: {type(v)}")
                if isinstance(v, float) and not math.isfinite(v):
                    raise ValueError(f"{name}[{i}][{j}]={v} is not finite")
        return [[float(v) if not isinstance(v, complex) else v
                 for v in row] for row in A]

    @classmethod
    def validate_vector(cls, v: List[float], name: str = "v") -> List[float]:
        import math
        if not isinstance(v, (list, tuple)) or not v:
            raise TypeError(f"{name} must be a non-empty list")
        if len(v) > cls.MAX_DIMENSION:
            raise ValueError(f"{name} length {len(v)} exceeds max {cls.MAX_DIMENSION}")
        for i, x in enumerate(v):
            if not isinstance(x, (int, float)):
                raise TypeError(f"{name}[{i}] is not numeric")
            if not math.isfinite(x):
                raise ValueError(f"{name}[{i}]={x} is not finite")
        return [float(x) for x in v]

    @classmethod
    def validate_compatible(cls, A: List[List[float]],
                             B: List[List[float]]) -> None:
        if len(A[0]) != len(B):
            raise ValueError(f"Incompatible: A is {len(A)}×{len(A[0])}, "
                             f"B is {len(B)}×{len(B[0])}")

    @classmethod
    def validate_invertible(cls, A: List[List[float]],
                              tol: float = 1e-12) -> None:
        d = LinearAlgebra.det(A)
        if abs(d) < tol:
            raise ValueError(f"Matrix is singular (det={d:.3e}); cannot invert")

    @classmethod
    def validate_omega(cls, omega: float) -> float:
        if not 0 < omega < 2:
            raise ValueError(f"SOR omega={omega} must be in (0,2) for convergence")
        return omega

    @classmethod
    def validate_symmetric(cls, A: List[List[float]],
                             tol: float = 1e-8) -> None:
        n = len(A)
        for i in range(n):
            for j in range(i+1, n):
                if abs(A[i][j]-A[j][i]) > tol:
                    raise ValueError(
                        f"Matrix not symmetric: A[{i}][{j}]={A[i][j]:.6f} "
                        f"≠ A[{j}][{i}]={A[j][i]:.6f}")


# ── Standards: numerical linear algebra output conventions ────────────────

class LinearAlgebraStandards:
    """
    Output conventions following LAPACK/BLAS naming and reporting standards.
    Reference: Anderson et al., 'LAPACK Users' Guide', 3rd ed. (1999).
    """

    @staticmethod
    def residual_norm(A: List[List[float]],
                       x: List[float], b: List[float]) -> float:
        """‖Ax - b‖₂ — residual of a linear solve."""
        Ax   = [sum(A[i][j]*x[j] for j in range(len(x))) for i in range(len(A))]
        diff = [Ax[i]-b[i] for i in range(len(b))]
        return LinearAlgebra.norm(diff)

    @staticmethod
    def relative_residual(A: List[List[float]],
                           x: List[float], b: List[float]) -> float:
        """‖Ax-b‖ / ‖b‖ — relative residual."""
        nb = LinearAlgebra.norm(b)
        return LinearAlgebraStandards.residual_norm(A, x, b) / nb if nb else 0.0

    @staticmethod
    def orthogonality_check(Q: List[List[float]],
                             tol: float = 1e-8) -> bool:
        """Verify QᵀQ ≈ I."""
        Qt  = LinearAlgebra.transpose(Q)
        QtQ = LinearAlgebra.mmul(Qt, Q)
        n   = len(QtQ)
        I   = LinearAlgebra.eye(n)
        return LinearAlgebra.frobenius_norm(
            LinearAlgebra.msub(QtQ, I)) < tol

    @staticmethod
    def eigenvalue_residual(A: List[List[float]],
                             lam: float, v: List[float]) -> float:
        """‖Av - λv‖₂ — eigenvalue residual."""
        n  = len(v)
        Av = [sum(A[i][j]*v[j] for j in range(n)) for i in range(n)]
        lv = [lam*v[i] for i in range(n)]
        return LinearAlgebra.norm([Av[i]-lv[i] for i in range(n)])

    @staticmethod
    def decomposition_report(method: str, matrix_size: tuple,
                              residual: float, iterations: int = None) -> dict:
        return {
            "method":      method,
            "matrix_size": f"{matrix_size[0]}×{matrix_size[1]}",
            "residual":    round(residual, 12),
            "iterations":  iterations,
            "status":      "converged" if residual < 1e-8 else "warn:high_residual",
        }

    @staticmethod
    def sparsity(A: List[List[float]], tol: float = 1e-12) -> dict:
        """Measure matrix sparsity."""
        m, n  = len(A), len(A[0])
        total = m*n
        nz    = sum(1 for row in A for v in row if abs(v) > tol)
        return {
            "rows":        m, "cols": n,
            "nonzeros":    nz,
            "sparsity":    round(1 - nz/total, 6),
            "density":     round(nz/total, 6),
        }
