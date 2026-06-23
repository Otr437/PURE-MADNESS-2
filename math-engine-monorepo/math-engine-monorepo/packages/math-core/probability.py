"""
Probability, NumberTheory, ComplexAnalysis, SpecialFunctions,
Optimization, and DifferentialEquations — all in one module,
each class massively extended.
"""
import cmath
import math
import random
from collections import Counter
from typing import Callable, Dict, List, Optional, Tuple


# ════════════════════════════════════════════════════════════
class Probability:
    @staticmethod
    def factorial(n: int) -> int: return math.factorial(n)
    @staticmethod
    def perm(n,k): return math.perm(n,k)
    @staticmethod
    def comb(n,k): return math.comb(n,k)
    @staticmethod
    def multinomial(*ns) -> int:
        total=sum(ns); return math.factorial(total)//math.prod(math.factorial(n) for n in ns)
    @staticmethod
    def catalan(n): return math.comb(2*n,n)//(n+1)
    @staticmethod
    def stirling_second(n,k):
        return sum((-1)**(k-j)*math.comb(k,j)*j**n for j in range(k+1))//math.factorial(k)
    @staticmethod
    def bell(n): return sum(Probability.stirling_second(n,k) for k in range(n+1))
    # ── Discrete distributions ────────────────────────────────────────────
    @staticmethod
    def binomial_pmf(n,k,p): return math.comb(n,k)*p**k*(1-p)**(n-k)
    @staticmethod
    def binomial_cdf(n,k,p): return sum(Probability.binomial_pmf(n,i,p) for i in range(k+1))
    @staticmethod
    def binomial_mean(n,p): return n*p
    @staticmethod
    def binomial_var(n,p): return n*p*(1-p)
    @staticmethod
    def poisson_pmf(lam,k): return lam**k*math.exp(-lam)/math.factorial(k)
    @staticmethod
    def poisson_cdf(lam,k): return sum(Probability.poisson_pmf(lam,i) for i in range(k+1))
    @staticmethod
    def geometric_pmf(p,k): return (1-p)**(k-1)*p
    @staticmethod
    def hypergeometric_pmf(N,K,n,k): return math.comb(K,k)*math.comb(N-K,n-k)/math.comb(N,n)
    @staticmethod
    def negative_binomial_pmf(r,p,k):
        return math.comb(k+r-1,k)*(1-p)**k*p**r
    # ── Continuous distributions ──────────────────────────────────────────
    @staticmethod
    def normal_pdf(x,mu=0,sigma=1):
        return math.exp(-((x-mu)**2)/(2*sigma**2))/(sigma*math.sqrt(2*math.pi))
    @staticmethod
    def normal_cdf(x,mu=0,sigma=1): return 0.5*(1+math.erf((x-mu)/(sigma*math.sqrt(2))))
    @staticmethod
    def normal_quantile(p,mu=0,sigma=1):
        """Inverse normal CDF via rational approximation (Beasley-Springer-Moro)."""
        if p<=0 or p>=1: raise ValueError("p must be in (0,1)")
        a=[2.506628277459095,0.0,-6.024212382264895,0.0,4.485581776169736,0.0,-0.4509485742523765]
        b=[1.0,-0.011421613153285,5.098316791395225,-0.022234700773571,-2.218879573929027,0.003490059707861,0.4613135869745785]
        c=[-7.784894002430293e-3,-0.322396458041136,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783]
        d=[7.784695709041462e-3,0.324467761166019,2.445134137142996,3.754408661907416]
        plow,phigh=0.02425,1-0.02425
        if p<plow:
            q=math.sqrt(-2*math.log(p))
            x=(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/(((d[0]*q+d[1])*q+d[2])*q+d[3])
        elif p<=phigh:
            q=p-0.5; r=q**2
            x=((((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*r+a[6])*q/(((((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+b[5])*r+b[6]))
        else:
            q=math.sqrt(-2*math.log(1-p))
            x=-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/(((d[0]*q+d[1])*q+d[2])*q+d[3])
        return mu+sigma*x
    @staticmethod
    def exponential_pdf(x,lam): return lam*math.exp(-lam*x) if x>=0 else 0
    @staticmethod
    def exponential_cdf(x,lam): return 1-math.exp(-lam*x) if x>=0 else 0
    @staticmethod
    def uniform_pdf(x,a,b): return 1/(b-a) if a<=x<=b else 0
    @staticmethod
    def gamma_pdf(x,shape,rate):
        if x<=0: return 0
        return rate**shape*x**(shape-1)*math.exp(-rate*x)/math.gamma(shape)
    @staticmethod
    def beta_pdf(x,a,b):
        if not 0<x<1: return 0
        return x**(a-1)*(1-x)**(b-1)/Probability._beta(a,b)
    @staticmethod
    def _beta(a,b): return math.gamma(a)*math.gamma(b)/math.gamma(a+b)
    @staticmethod
    def chi_squared_pdf(x,k):
        if x<=0: return 0
        return x**(k/2-1)*math.exp(-x/2)/(2**(k/2)*math.gamma(k/2))
    @staticmethod
    def t_pdf(x,nu):
        return (1+(x**2/nu))**(-(nu+1)/2)*math.gamma((nu+1)/2)/(math.sqrt(nu*math.pi)*math.gamma(nu/2))
    # ── Information theory ────────────────────────────────────────────────
    @staticmethod
    def entropy(probs,base=2): return -sum(p*math.log(p,base) for p in probs if p>0)
    @staticmethod
    def cross_entropy(p,q,base=2): return -sum(pi*math.log(qi,base) for pi,qi in zip(p,q) if pi>0 and qi>0)
    @staticmethod
    def kl_divergence(p,q): return sum(pi*math.log(pi/qi) for pi,qi in zip(p,q) if pi>0 and qi>0)
    @staticmethod
    def mutual_information(joint,marginal_x,marginal_y):
        return sum(sum(joint[i][j]*math.log(joint[i][j]/(marginal_x[i]*marginal_y[j]))
                       for j in range(len(marginal_y)) if joint[i][j]>0)
                   for i in range(len(marginal_x)))
    # ── Expectation ───────────────────────────────────────────────────────
    @staticmethod
    def expected(vals,probs=None): return sum(v*(probs[i] if probs else 1/len(vals)) for i,v in enumerate(vals))
    @staticmethod
    def variance_prob(vals,probs=None):
        mu=Probability.expected(vals,probs)
        return sum((v-mu)**2*(probs[i] if probs else 1/len(vals)) for i,v in enumerate(vals))
    @staticmethod
    def moment(vals, order:int, probs=None):
        mu=Probability.expected(vals,probs)
        return sum((v-mu)**order*(probs[i] if probs else 1/len(vals)) for i,v in enumerate(vals))
    @staticmethod
    def bayes(p_a,p_b_given_a,p_b): return p_b_given_a*p_a/p_b
    # ── Markov chains ─────────────────────────────────────────────────────
    @staticmethod
    def markov_stationary(T: List[List[float]]) -> List[float]:
        """Stationary distribution via power iteration."""
        n=len(T); pi=[1/n]*n
        for _ in range(1000):
            new_pi=[sum(pi[j]*T[j][i] for j in range(n)) for i in range(n)]
            if max(abs(new_pi[i]-pi[i]) for i in range(n))<1e-12: return new_pi
            pi=new_pi
        return pi
    @staticmethod
    def markov_n_step(T,n): 
        result=T[:]
        for _ in range(n-1): result=[[sum(result[i][k]*T[k][j] for k in range(len(T))) for j in range(len(T))] for i in range(len(T))]
        return result


# ════════════════════════════════════════════════════════════
class NumberTheory:
    @staticmethod
    def gcd(a,b): return math.gcd(a,b)
    @staticmethod
    def lcm(a,b): return abs(a*b)//math.gcd(a,b)
    @staticmethod
    def extended_gcd(a,b):
        if b==0: return abs(a),(1 if a>=0 else -1),0
        g,x1,y1=NumberTheory.extended_gcd(b,a%b)
        return g,y1,x1-(a//b)*y1
    @staticmethod
    def is_prime(n):
        if n<2: return False
        if n in(2,3,5,7): return True
        if n%2==0 or n%3==0 or n%5==0: return False
        i=7
        while i*i<=n:
            if n%i==0 or n%(i+2)==0: return False
            i+=6
        return True
    @staticmethod
    def miller_rabin(n,k=40):
        if n<2: return False
        if n in(2,3): return True
        if n%2==0: return False
        r,d=0,n-1
        while d%2==0: r+=1; d//=2
        for _ in range(k):
            a=random.randrange(2,n-1); x=pow(a,d,n)
            if x in(1,n-1): continue
            for _ in range(r-1):
                x=pow(x,2,n)
                if x==n-1: break
            else: return False
        return True
    @staticmethod
    def next_prime(n):
        n+=1+(n%2==0)
        while not NumberTheory.miller_rabin(n): n+=2
        return n
    @staticmethod
    def prime_sieve(n) -> List[int]:
        """Sieve of Eratosthenes up to n."""
        sieve=[True]*(n+1); sieve[0]=sieve[1]=False
        for i in range(2,math.isqrt(n)+1):
            if sieve[i]:
                for j in range(i*i,n+1,i): sieve[j]=False
        return [i for i in range(n+1) if sieve[i]]
    @staticmethod
    def prime_factors(n):
        f=[]; d=2
        while d*d<=n:
            while n%d==0: f.append(d); n//=d
            d+=1 if d==2 else 2
        if n>1: f.append(n)
        return f
    @staticmethod
    def factorization(n) -> Dict[int,int]:
        pf=NumberTheory.prime_factors(n); return dict(Counter(pf))
    @staticmethod
    def divisors(n): return sorted({i for i in range(1,math.isqrt(n)+1) if n%i==0}|{n//i for i in range(1,math.isqrt(n)+1) if n%i==0})
    @staticmethod
    def sum_divisors(n): return sum(NumberTheory.divisors(n))
    @staticmethod
    def euler_totient(n):
        r=n; p=2
        while p*p<=n:
            if n%p==0:
                while n%p==0: n//=p
                r-=r//p
            p+=1
        if n>1: r-=r//n
        return r
    @staticmethod
    def carmichael_lambda(n):
        def _lambda(pk,p): return pk//p*(p-1) if p!=2 or pk<=4 else pk//4
        pf=NumberTheory.factorization(n)
        lambdas=[_lambda(p**k,p) for p,k in pf.items()]
        return NumberTheory.lcm_multiple(lambdas)
    @staticmethod
    def lcm_multiple(nums):
        from functools import reduce
        return reduce(lambda a,b:abs(a*b)//math.gcd(a,b), nums)
    @staticmethod
    def mobius(n):
        if n==1: return 1
        pf=NumberTheory.prime_factors(n)
        return 0 if len(set(pf))!=len(pf) else (-1)**len(pf)
    @staticmethod
    def mod_inv(a,m): g,x,_=NumberTheory.extended_gcd(a,m); return x%m if g==1 else None
    @staticmethod
    def mod_pow(b,e,m): return pow(b,e,m)
    @staticmethod
    def crt(rs,ms):
        total=0; M=math.prod(ms)
        for r,m in zip(rs,ms):
            p=M//m; inv=NumberTheory.mod_inv(p,m)
            if inv is None: return None
            total+=r*inv*p
        return total%M
    @staticmethod
    def legendre(a,p): ls=pow(a,(p-1)//2,p); return -1 if ls==p-1 else ls
    @staticmethod
    def jacobi(a,n):
        if n<=0 or n%2==0: raise ValueError
        a%=n; result=1
        while a:
            while a%2==0:
                a//=2
                if n%8 in(3,5): result=-result
            a,n=n,a
            if a%4==3 and n%4==3: result=-result
            a%=n
        return result if n==1 else 0
    @staticmethod
    def tonelli_shanks(n,p):
        if NumberTheory.legendre(n,p)!=1: return None
        if p%4==3: return pow(n,(p+1)//4,p)
        Q=p-1; S=0
        while Q%2==0: Q//=2; S+=1
        z=2
        while NumberTheory.legendre(z,p)!=-1: z+=1
        M=S; c=pow(z,Q,p); t=pow(n,Q,p); R=pow(n,(Q+1)//2,p)
        while t!=1:
            i=0; tmp=t
            while tmp!=1: tmp=pow(tmp,2,p); i+=1
            b=pow(c,1<<(M-i-1),p); M=i; c=pow(b,2,p); t=t*c%p; R=R*b%p
        return R
    @staticmethod
    def baby_giant(g,h,p):
        m=math.isqrt(p)+1; table={}; e=1
        for i in range(m): table.setdefault(e,i); e=e*g%p
        factor=pow(g,p-1-m,p); e=h
        for j in range(m):
            if e in table: return j*m+table[e]
            e=e*factor%p
        return None
    @staticmethod
    def pollards_rho(n):
        if n%2==0: return 2
        x=y=2; d=1; f=lambda x:(x*x+1)%n
        while d==1: x=f(x); y=f(f(y)); d=math.gcd(abs(x-y),n)
        return d if d!=n else None
    @staticmethod
    def is_perfect(n): return n>1 and sum(NumberTheory.divisors(n))-n==n
    @staticmethod
    def is_abundant(n): return sum(NumberTheory.divisors(n))-n>n
    @staticmethod
    def is_deficient(n): return sum(NumberTheory.divisors(n))-n<n
    @staticmethod
    def collatz(n) -> List[int]:
        seq=[n]
        while n!=1:
            n=n//2 if n%2==0 else 3*n+1; seq.append(n)
        return seq
    @staticmethod
    def fibonacci(n) -> int:
        if n<=1: return n
        a,b=0,1
        for _ in range(n-1): a,b=b,a+b
        return b
    @staticmethod
    def lucas(n) -> int:
        if n==0: return 2
        if n==1: return 1
        a,b=2,1
        for _ in range(n-1): a,b=b,a+b
        return b
    @staticmethod
    def nthroot_mod(n,k,p):
        """Compute x such that x^k ≡ n (mod p), p prime."""
        g=NumberTheory.mod_inv(k,(p-1))
        if g is None: return None
        return pow(n,g,p)
    @staticmethod
    def primitive_root(p):
        """Find a primitive root of prime p."""
        phi=p-1; pf=set(NumberTheory.prime_factors(phi))
        for g in range(2,p):
            if all(pow(g,phi//f,p)!=1 for f in pf): return g
        return None


# ════════════════════════════════════════════════════════════
class ComplexAnalysis:
    @staticmethod
    def polar(r,theta): return complex(r*math.cos(theta), r*math.sin(theta))
    @staticmethod
    def to_polar(z): return abs(z), cmath.phase(z)
    @staticmethod
    def roots_of_unity(n): return [cmath.exp(2j*math.pi*k/n) for k in range(n)]
    @staticmethod
    def nth_roots(z,n): r=abs(z)**(1/n); t=cmath.phase(z); return [ComplexAnalysis.polar(r,(t+2*math.pi*k)/n) for k in range(n)]
    @staticmethod
    def complex_log(z): return cmath.log(z)
    @staticmethod
    def complex_exp(z): return cmath.exp(z)
    @staticmethod
    def euler(theta): return cmath.exp(1j*theta)
    @staticmethod
    def de_moivre(r,theta,n): return r**n*ComplexAnalysis.euler(n*theta)
    @staticmethod
    def mobius_transform(z,a,b,c,d): return (a*z+b)/(c*z+d) if c*z+d!=0 else float("inf")
    @staticmethod
    def riemann_sphere(z):
        """Map ℂ to unit sphere (stereographic projection)."""
        x,y=z.real,z.imag; denom=1+x**2+y**2
        return (2*x/denom, 2*y/denom, (denom-2)/denom)
    @staticmethod
    def residue(f,z0,order=1,h=1e-6):
        """Numerical residue of f at z0 (simple pole assumed)."""
        if order==1: return (z0+h-z0)*f(z0+h)  # approximate
        return cmath.exp(cmath.log(h)*(1-order)) * f(z0+h)
    @staticmethod
    def contour_integral_circle(f,center,radius,n=1000):
        """Numerical contour integral around a circle."""
        total=0j; dtheta=2*math.pi/n
        for k in range(n):
            theta=k*dtheta
            z=center+radius*cmath.exp(1j*theta)
            dz=1j*radius*cmath.exp(1j*theta)*dtheta
            total+=f(z)*dz
        return total
    @staticmethod
    def mandelbrot(c,max_iter=256):
        """Number of iterations before |z|>2 (0 if in set)."""
        z=0j
        for i in range(max_iter):
            z=z*z+c
            if abs(z)>2: return i
        return 0
    @staticmethod
    def julia(z,c,max_iter=256):
        for i in range(max_iter):
            z=z*z+c
            if abs(z)>2: return i
        return 0


# ════════════════════════════════════════════════════════════
class SpecialFunctions:
    @staticmethod
    def gamma(x): return math.gamma(x)
    @staticmethod
    def lgamma(x): return math.lgamma(x)
    @staticmethod
    def beta(a,b): return math.gamma(a)*math.gamma(b)/math.gamma(a+b)
    @staticmethod
    def incomplete_beta(x,a,b,n=1000):
        """Regularized incomplete beta function I_x(a,b)."""
        if x<=0: return 0.0
        if x>=1: return 1.0
        from math import log,exp
        # Series expansion
        result=0.0; term=1.0
        for k in range(n):
            if k>0: term*=x*(a+b+k-1)/((a+k)*k)
            result+=term/(a+k)
            if abs(term)<1e-14: break
        return x**a*(1-x)**b*result/SpecialFunctions.beta(a,b)
    @staticmethod
    def erf(x): return math.erf(x)
    @staticmethod
    def erfc(x): return math.erfc(x)
    @staticmethod
    def erfinv(y):
        """Inverse error function."""
        a=0.147; ln=math.log(1-y**2); t=2/(math.pi*a)+ln/2
        return math.copysign(math.sqrt(math.sqrt(t**2-ln/a)-t),y)
    @staticmethod
    def zeta(s,terms=10000):
        if s<=1: raise ValueError("s>1")
        return sum(1/n**s for n in range(1,terms+1))
    @staticmethod
    def dirichlet_eta(s,terms=5000):
        """Dirichlet eta function (converges for Re(s)>0)."""
        return sum((-1)**(n-1)/n**s for n in range(1,terms+1))
    @staticmethod
    def sinc(x): return math.sin(x)/x if x else 1.0
    @staticmethod
    def sinch(x): return math.sinh(x)/x if x else 1.0
    @staticmethod
    def legendre_p(n,x):
        if n==0: return 1.0
        if n==1: return float(x)
        return ((2*n-1)*x*SpecialFunctions.legendre_p(n-1,x)-(n-1)*SpecialFunctions.legendre_p(n-2,x))/n
    @staticmethod
    def hermite_h(n,x):
        if n==0: return 1.0
        if n==1: return 2*x
        return 2*x*SpecialFunctions.hermite_h(n-1,x)-2*(n-1)*SpecialFunctions.hermite_h(n-2,x)
    @staticmethod
    def laguerre_l(n,x):
        if n==0: return 1.0
        if n==1: return 1-x
        return ((2*n-1-x)*SpecialFunctions.laguerre_l(n-1,x)-(n-1)*SpecialFunctions.laguerre_l(n-2,x))/n
    @staticmethod
    def chebyshev_t(n,x):
        if n==0: return 1.0
        if n==1: return float(x)
        return 2*x*SpecialFunctions.chebyshev_t(n-1,x)-SpecialFunctions.chebyshev_t(n-2,x)
    @staticmethod
    def chebyshev_u(n,x):
        if n==0: return 1.0
        if n==1: return 2*x
        return 2*x*SpecialFunctions.chebyshev_u(n-1,x)-SpecialFunctions.chebyshev_u(n-2,x)
    @staticmethod
    def bessel_j(n,x,terms=50):
        return sum((-1)**k*(x/2)**(2*k+n)/(math.factorial(k)*math.gamma(k+n+1)) for k in range(terms))
    @staticmethod
    def airy_ai(x,terms=30):
        """Airy Ai function via power series."""
        c1=1/(3**(2/3)*math.gamma(2/3)); c2=1/(3**(1/3)*math.gamma(1/3))
        s1=sum(x**(3*k)/(math.factorial(3*k)) for k in range(terms) if 3*k<=90)
        s2=sum(x**(3*k+1)/(math.factorial(3*k+1)) for k in range(terms) if 3*k+1<=90)
        return c1*s1 - c2*s2
    @staticmethod
    def lambert_w(x, max_iter=100, tol=1e-12):
        """Principal branch W₀(x) of Lambert W function."""
        if x < -1/math.e: raise ValueError("x < -1/e")
        w = math.log(x+1) if x>0 else x  # initial guess
        for _ in range(max_iter):
            ew=math.exp(w); we=w*ew
            dw=(we-x)/(ew*(w+1)-((w+2)*(we-x))/(2*w+2))
            w-=dw
            if abs(dw)<tol: break
        return w
    @staticmethod
    def polygamma(n,x,terms=1000):
        """Polygamma function ψ^(n)(x) for integer n≥0."""
        if n==0: return -0.5772156649 - 1/x + sum(1/(k*(k+x)) for k in range(1,terms))
        sign=(-1)**(n+1); fac=math.factorial(n)
        return sign*fac*sum(1/(x+k)**(n+1) for k in range(terms))
    @staticmethod
    def hypergeometric_2f1(a,b,c,z,terms=50):
        """Gauss hypergeometric function ₂F₁(a,b;c;z)."""
        result=1.0; term=1.0
        for n in range(1,terms):
            term*=(a+n-1)*(b+n-1)/((c+n-1)*n)*z
            result+=term
            if abs(term)<1e-14: break
        return result


# ════════════════════════════════════════════════════════════
class Optimization:
    @staticmethod
    def gradient_descent(f,grad,x0,lr=0.01,max_iter=1000,tol=1e-6):
        x=x0[:]
        for i in range(max_iter):
            g=grad(x); gn=math.sqrt(sum(gi**2 for gi in g))
            if gn<tol: return x,f(x),i
            x=[xi-lr*gi for xi,gi in zip(x,g)]
        return x,f(x),max_iter
    @staticmethod
    def momentum_gd(f,grad,x0,lr=0.01,momentum=0.9,max_iter=1000,tol=1e-6):
        x=x0[:]; v=[0.0]*len(x)
        for i in range(max_iter):
            g=grad(x)
            v=[momentum*vi-lr*gi for vi,gi in zip(v,g)]
            x=[xi+vi for xi,vi in zip(x,v)]
            if math.sqrt(sum(gi**2 for gi in g))<tol: return x,f(x),i
        return x,f(x),max_iter
    @staticmethod
    def adam(f,grad,x0,lr=0.001,b1=0.9,b2=0.999,eps=1e-8,max_iter=1000,tol=1e-6):
        x=x0[:]; m=[0.0]*len(x); v=[0.0]*len(x)
        for t in range(1,max_iter+1):
            g=grad(x)
            m=[b1*mi+(1-b1)*gi for mi,gi in zip(m,g)]
            v=[b2*vi+(1-b2)*gi**2 for vi,gi in zip(v,g)]
            mh=[mi/(1-b1**t) for mi in m]; vh=[vi/(1-b2**t) for vi in v]
            x=[xi-lr*mhi/(math.sqrt(vhi)+eps) for xi,mhi,vhi in zip(x,mh,vh)]
            if math.sqrt(sum(gi**2 for gi in g))<tol: return x,f(x),t
        return x,f(x),max_iter
    @staticmethod
    def rmsprop(f,grad,x0,lr=0.01,decay=0.9,eps=1e-8,max_iter=1000,tol=1e-6):
        x=x0[:]; cache=[0.0]*len(x)
        for i in range(max_iter):
            g=grad(x)
            cache=[decay*c+(1-decay)*gi**2 for c,gi in zip(cache,g)]
            x=[xi-lr*gi/(math.sqrt(c)+eps) for xi,gi,c in zip(x,g,cache)]
            if math.sqrt(sum(gi**2 for gi in g))<tol: return x,f(x),i
        return x,f(x),max_iter
    @staticmethod
    def newton(f,fp,x0,max_iter=100,tol=1e-10):
        x=x0
        for _ in range(max_iter):
            fx=f(x)
            if abs(fx)<tol: return x
            fpx=fp(x)
            if fpx==0: return None
            x-=fx/fpx
        return x
    @staticmethod
    def halley(f,fp,fpp,x0,max_iter=50,tol=1e-12):
        """Halley's method (cubic convergence)."""
        x=x0
        for _ in range(max_iter):
            fx=f(x); fpx=fp(x); fppx=fpp(x)
            denom=2*fpx**2-fx*fppx
            if abs(denom)<1e-14: return None
            x-=2*fx*fpx/denom
            if abs(fx)<tol: return x
        return x
    @staticmethod
    def bisection(f,a,b,max_iter=200,tol=1e-12):
        fa=f(a)
        if fa*f(b)>0: return None
        for _ in range(max_iter):
            c=(a+b)/2; fc=f(c)
            if abs(fc)<tol: return c
            if fa*fc<0: b=c
            else: a=c; fa=fc
        return (a+b)/2
    @staticmethod
    def brent(f,a,b,tol=1e-12,max_iter=200):
        """Brent's method — robust root finding."""
        fa,fb=f(a),f(b)
        if fa*fb>0: return None
        if abs(fa)<abs(fb): a,b,fa,fb=b,a,fb,fa
        c,fc=a,fa; mflag=True; s=b; d=0.0
        for _ in range(max_iter):
            if abs(b-a)<tol: return b
            if fa!=fc and fb!=fc:
                s=(a*fb*fc/((fa-fb)*(fa-fc))+b*fa*fc/((fb-fa)*(fb-fc))
                   +c*fa*fb/((fc-fa)*(fc-fb)))
            else:
                s=b-fb*(b-a)/(fb-fa)
            cond1=not ((3*a+b)/4<s<b or b<s<(3*a+b)/4)
            cond2=mflag and abs(s-b)>=abs(b-c)/2
            cond3=not mflag and abs(s-b)>=abs(c-d)/2
            if cond1 or cond2 or cond3: s=(a+b)/2; mflag=True
            else: mflag=False
            fs=f(s); d=c; c,fc=b,fb
            if fa*fs<0: b,fb=s,fs
            else: a,fa=s,fs
            if abs(fa)<abs(fb): a,b,fa,fb=b,a,fb,fa
        return b
    @staticmethod
    def golden_section(f,a,b,tol=1e-8):
        phi=(math.sqrt(5)-1)/2; c=b-(b-a)*phi; d=a+(b-a)*phi
        while abs(b-a)>tol:
            if f(c)<f(d): b=d
            else: a=c
            c=b-(b-a)*phi; d=a+(b-a)*phi
        return (a+b)/2
    @staticmethod
    def nelder_mead(f,x0,alpha=1,gamma=2,rho=0.5,sigma=0.5,max_iter=1000,tol=1e-8):
        n=len(x0); simplex=[x0[:]]
        for i in range(n):
            p=x0[:]; p[i]+=(1.0 if p[i]==0 else 0.25*abs(p[i]))
            simplex.append(p)
        for _ in range(max_iter):
            simplex.sort(key=f)
            if max(abs(f(simplex[i])-f(simplex[0])) for i in range(1,n+1))<tol:
                return simplex[0],f(simplex[0])
            x0_=[sum(simplex[i][j] for i in range(n))/n for j in range(n)]
            xr=[x0_[j]+alpha*(x0_[j]-simplex[-1][j]) for j in range(n)]
            fr=f(xr)
            if f(simplex[0])<=fr<f(simplex[-2]): simplex[-1]=xr
            elif fr<f(simplex[0]):
                xe=[x0_[j]+gamma*(xr[j]-x0_[j]) for j in range(n)]
                simplex[-1]=(xe if f(xe)<fr else xr)
            else:
                xc=[x0_[j]+rho*(simplex[-1][j]-x0_[j]) for j in range(n)]
                if f(xc)<f(simplex[-1]): simplex[-1]=xc
                else:
                    for i in range(1,n+1):
                        simplex[i]=[simplex[0][j]+sigma*(simplex[i][j]-simplex[0][j]) for j in range(n)]
        simplex.sort(key=f); return simplex[0],f(simplex[0])
    @staticmethod
    def simulated_annealing(f,x0,T=1.0,T_min=1e-8,alpha=0.99,max_iter=10000):
        import random
        x=x0[:]; best=x[:]; fx=f(x); best_f=fx
        while T>T_min:
            for _ in range(max_iter):
                xn=[xi+random.gauss(0,T) for xi in x]
                fn=f(xn); dE=fn-fx
                if dE<0 or random.random()<math.exp(-dE/T):
                    x,fx=xn,fn
                    if fx<best_f: best,best_f=x[:],fx
            T*=alpha
        return best, best_f
    @staticmethod
    def differential_evolution(f,bounds,pop=20,F=0.8,CR=0.9,max_gen=1000,tol=1e-8):
        import random
        d=len(bounds)
        population=[[random.uniform(lo,hi) for lo,hi in bounds] for _ in range(pop)]
        fitness=[f(ind) for ind in population]
        for _ in range(max_gen):
            for i in range(pop):
                idxs=[j for j in range(pop) if j!=i]
                a,b,c=[population[j] for j in random.sample(idxs,3)]
                mutant=[a[k]+F*(b[k]-c[k]) for k in range(d)]
                mutant=[max(bounds[k][0],min(bounds[k][1],mutant[k])) for k in range(d)]
                trial=[mutant[k] if random.random()<CR else population[i][k] for k in range(d)]
                ft=f(trial)
                if ft<fitness[i]: population[i],fitness[i]=trial,ft
            if max(fitness)-min(fitness)<tol: break
        best_i=min(range(pop),key=lambda i:fitness[i])
        return population[best_i],fitness[best_i]
    @staticmethod
    def lbfgs(f,grad,x0,m=10,max_iter=1000,tol=1e-6):
        """Limited-memory BFGS."""
        x=x0[:]; n=len(x); ss=[]; ys=[]; rhos=[]
        g=grad(x)
        for k in range(max_iter):
            if math.sqrt(sum(gi**2 for gi in g))<tol: break
            q=g[:]
            alphas=[]
            for s,y,rho in reversed(list(zip(ss,ys,rhos))):
                a=rho*sum(s[i]*q[i] for i in range(n)); alphas.insert(0,a)
                q=[q[i]-a*y[i] for i in range(n)]
            r=q[:]
            for s,y,rho,a in zip(ss,ys,rhos,alphas):
                beta=rho*sum(y[i]*r[i] for i in range(n))
                r=[r[i]+s[i]*(a-beta) for i in range(n)]
            p=[-ri for ri in r]; step=1.0
            x_new=[x[i]+step*p[i] for i in range(n)]
            g_new=grad(x_new); s=[x_new[i]-x[i] for i in range(n)]
            y=[g_new[i]-g[i] for i in range(n)]
            sy=sum(s[i]*y[i] for i in range(n))
            if abs(sy)>1e-14:
                if len(ss)>=m: ss.pop(0); ys.pop(0); rhos.pop(0)
                ss.append(s); ys.append(y); rhos.append(1/sy)
            x,g=x_new,g_new
        return x,f(x)


# ════════════════════════════════════════════════════════════
class DifferentialEquations:
    @staticmethod
    def euler(f,y0,t0,tf,h=0.1):
        t,y=t0,y0; res=[(t,y)]
        while t<tf: y+=h*f(t,y); t+=h; res.append((t,y))
        return res
    @staticmethod
    def rk4(f,y0,t0,tf,h=0.1):
        t,y=t0,y0; res=[(t,y)]
        while t<tf:
            k1=f(t,y); k2=f(t+h/2,y+h*k1/2)
            k3=f(t+h/2,y+h*k2/2); k4=f(t+h,y+h*k3)
            y+=h*(k1+2*k2+2*k3+k4)/6; t+=h; res.append((t,y))
        return res
    @staticmethod
    def rk45(f,y0,t0,tf,tol=1e-6,h0=0.1):
        """Runge-Kutta-Fehlberg (RK45) adaptive step."""
        c2,c3,c4,c5=1/4,3/8,12/13,1.0
        a21=1/4; a31,a32=3/32,9/32; a41,a42,a43=1932/2197,-7200/2197,7296/2197
        a51,a52,a53,a54=439/216,-8.0,3680/513,-845/4104
        a61,a62,a63,a64,a65=-8/27,2.0,-3544/2565,1859/4104,-11/40
        b1,b3,b4,b5=25/216,0.0,1408/2565,2197/4104; b6=-1/5
        e1,e3,e4,e5,e6=1/360,0,-128/4275,-2197/75240,1/50; e7=2/55
        t,y=t0,y0; h=h0; res=[(t,y)]
        while t<tf:
            if t+h>tf: h=tf-t
            k1=f(t,y)
            k2=f(t+c2*h,y+h*a21*k1)
            k3=f(t+c3*h,y+h*(a31*k1+a32*k2))
            k4=f(t+c4*h,y+h*(a41*k1+a42*k2+a43*k3))
            k5=f(t+c5*h,y+h*(a51*k1+a52*k2+a53*k3+a54*k4))
            k6=f(t+h,y+h*(a61*k1+a62*k2+a63*k3+a64*k4+a65*k5))
            y4=y+h*(b1*k1+b3*k3+b4*k4+b5*k5+b6*k6)
            err=abs(h*(e1*k1+e3*k3+e4*k4+e5*k5+e6*k6+e7*f(t+h,y4)))
            if err<tol or h<1e-10:
                y=y4; t+=h; res.append((t,y))
            h*=min(2.0,max(0.1,(0.84*(tol/(err+1e-20))**0.25)))
        return res
    @staticmethod
    def adams_bashforth(f,y0,t0,tf,h=0.1):
        """4-step Adams-Bashforth explicit method."""
        pts=DifferentialEquations.rk4(f,y0,t0,t0+3*h+1e-12,h)
        ts=[p[0] for p in pts]; ys=[p[1] for p in pts]
        fs=[f(ts[i],ys[i]) for i in range(len(ts))]
        while ts[-1]<tf:
            yn=ys[-1]+h*(55*fs[-1]-59*fs[-2]+37*fs[-3]-9*fs[-4])/24
            tn=ts[-1]+h; ts.append(tn); ys.append(yn); fs.append(f(tn,yn))
        return list(zip(ts,ys))
    @staticmethod
    def bdf2(f,y0,y1,t0,h=0.1,steps=100):
        """2nd-order Backward Differentiation Formula (implicit, Newton solve)."""
        ts=[t0,t0+h]; ys=[y0,y1]; res=list(zip(ts,ys))
        for _ in range(steps-1):
            t_new=ts[-1]+h
            # Initial guess via extrapolation
            yn_guess=2*ys[-1]-ys[-2]
            # Newton iteration
            for __ in range(50):
                fval=yn_guess-4/3*ys[-1]+1/3*ys[-2]-2/3*h*f(t_new,yn_guess)
                dfval=1-2/3*h*(f(t_new,yn_guess+1e-7)-f(t_new,yn_guess))/1e-7
                step=fval/dfval if abs(dfval)>1e-15 else 0
                yn_guess-=step
                if abs(step)<1e-12: break
            ts.append(t_new); ys.append(yn_guess); res.append((t_new,yn_guess))
        return res
    @staticmethod
    def rk4_system(fs,y0,t0,tf,h=0.1):
        t,y=t0,y0[:]; n=len(y); res=[(t,y[:])]
        while t<tf:
            k1=[fs[i](t,y) for i in range(n)]
            y2=[y[i]+h*k1[i]/2 for i in range(n)]; k2=[fs[i](t+h/2,y2) for i in range(n)]
            y3=[y[i]+h*k2[i]/2 for i in range(n)]; k3=[fs[i](t+h/2,y3) for i in range(n)]
            y4=[y[i]+h*k3[i] for i in range(n)]; k4=[fs[i](t+h,y4) for i in range(n)]
            y=[y[i]+h*(k1[i]+2*k2[i]+2*k3[i]+k4[i])/6 for i in range(n)]
            t+=h; res.append((t,y[:]))
        return res
    @staticmethod
    def shooting_method(f,ya,yb,t0,tf,h=0.1,tol=1e-8,max_iter=50):
        """Shooting method for 2-point BVP y''=f(t,y,y')."""
        def shoot(s0):
            def sys(t,y): return [y[1], f(t,y[0],y[1])]
            result=DifferentialEquations.rk4_system(sys,[ya,s0],t0,tf,h)
            return result[-1][1][0]-yb
        # Bisect on slope s0
        s_lo,s_hi=-100.0,100.0
        for _ in range(max_iter):
            s_mid=(s_lo+s_hi)/2; v=shoot(s_mid)
            if abs(v)<tol: break
            if shoot(s_lo)*v<0: s_hi=s_mid
            else: s_lo=s_mid
        def sys(t,y): return [y[1], f(t,y[0],y[1])]
        return DifferentialEquations.rk4_system(sys,[ya,(s_lo+s_hi)/2],t0,tf,h)
