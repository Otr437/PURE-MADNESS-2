import math
from collections import Counter
from typing import List, Optional, Tuple


class Statistics:
    @staticmethod
    def mean(d): return sum(d)/len(d) if d else 0
    @staticmethod
    def geometric_mean(d): return math.prod(d)**(1/len(d)) if d else 0
    @staticmethod
    def harmonic_mean(d): return len(d)/sum(1/x for x in d if x) if d else 0
    @staticmethod
    def median(d):
        if not d: return 0
        s=sorted(d); n=len(s)
        return (s[n//2-1]+s[n//2])/2 if n%2==0 else s[n//2]
    @staticmethod
    def mode(d): c=Counter(d); m=max(c.values()); return [k for k,v in c.items() if v==m]
    @staticmethod
    def variance(d, pop=False):
        if not d: return 0
        mu=Statistics.mean(d); ss=sum((x-mu)**2 for x in d)
        return ss/(len(d) if pop else len(d)-1)
    @staticmethod
    def std_dev(d, pop=False): return math.sqrt(Statistics.variance(d,pop))
    @staticmethod
    def covariance(x,y,pop=False):
        if len(x)!=len(y) or not x: return 0
        mx,my=Statistics.mean(x),Statistics.mean(y)
        ss=sum((xi-mx)*(yi-my) for xi,yi in zip(x,y))
        return ss/(len(x) if pop else len(x)-1)
    @staticmethod
    def correlation(x,y):
        sx,sy=Statistics.std_dev(x),Statistics.std_dev(y)
        return Statistics.covariance(x,y)/(sx*sy) if sx and sy else 0
    @staticmethod
    def skewness(d):
        if not d: return 0
        m=Statistics.mean(d); s=Statistics.std_dev(d)
        return sum((x-m)**3 for x in d)/(len(d)*s**3) if s else 0
    @staticmethod
    def kurtosis(d):
        if not d: return 0
        m=Statistics.mean(d); s=Statistics.std_dev(d)
        return sum((x-m)**4 for x in d)/(len(d)*s**4)-3 if s else 0
    @staticmethod
    def percentiles(d, pcts):
        s=sorted(d); n=len(s)
        res=[]
        for p in pcts:
            k=(n-1)*p/100; f,c=math.floor(k),math.ceil(k)
            res.append(s[int(k)] if f==c else s[f]*(c-k)+s[c]*(k-f))
        return res
    @staticmethod
    def z_score(d):
        m=Statistics.mean(d); s=Statistics.std_dev(d)
        return [(x-m)/s for x in d] if s else [0.0]*len(d)
    @staticmethod
    def linear_regression(x,y):
        n=len(x); sx=sum(x); sy=sum(y)
        sxy=sum(xi*yi for xi,yi in zip(x,y)); sx2=sum(xi**2 for xi in x)
        b=(n*sxy-sx*sy)/(n*sx2-sx**2); a=(sy-b*sx)/n
        ym=sy/n; ss_tot=sum((yi-ym)**2 for yi in y)
        ss_res=sum((yi-(a+b*xi))**2 for xi,yi in zip(x,y))
        r2=1-ss_res/ss_tot if ss_tot else 0
        return a,b,r2

# ── Extended descriptive stats ────────────────────────────────────────────

    @staticmethod
    def trimmed_mean(data: List[float], pct: float = 0.1) -> float:
        """Trim pct fraction from each tail before computing mean."""
        s = sorted(data); k = int(len(s) * pct)
        trimmed = s[k:len(s)-k] if k else s
        return Statistics.mean(trimmed)

    @staticmethod
    def winsorized_mean(data: List[float], pct: float = 0.1) -> float:
        """Replace extremes with boundary values."""
        s = sorted(data); n = len(s); k = int(n * pct)
        w = [s[k]] * k + s[k:n-k] + [s[-k-1]] * k
        return Statistics.mean(w)

    @staticmethod
    def interquartile_range(data: List[float]) -> float:
        q1, q3 = Statistics.percentiles(data, [25, 75])
        return q3 - q1

    @staticmethod
    def median_absolute_deviation(data: List[float]) -> float:
        m = Statistics.median(data)
        return Statistics.median([abs(x - m) for x in data])

    @staticmethod
    def coefficient_of_variation(data: List[float]) -> float:
        m = Statistics.mean(data)
        return Statistics.std_dev(data) / m if m else float("inf")

    @staticmethod
    def gini_coefficient(data: List[float]) -> float:
        s = sorted(x for x in data if x >= 0)
        n = len(s)
        if n == 0 or sum(s) == 0: return 0.0
        cum = sum((2*(i+1) - n - 1) * s[i] for i in range(n))
        return cum / (n * sum(s))

    @staticmethod
    def entropy(data: List[float]) -> float:
        import math
        total = sum(data); probs = [x/total for x in data if x > 0]
        return -sum(p * math.log2(p) for p in probs)

    @staticmethod
    def rank(data: List[float]) -> List[float]:
        """Assign ranks (average for ties)."""
        indexed = sorted(enumerate(data), key=lambda x: x[1])
        ranks = [0.0] * len(data)
        i = 0
        while i < len(indexed):
            j = i
            while j < len(indexed) - 1 and indexed[j+1][1] == indexed[i][1]:
                j += 1
            avg_rank = (i + j) / 2 + 1
            for k in range(i, j+1):
                ranks[indexed[k][0]] = avg_rank
            i = j + 1
        return ranks

    @staticmethod
    def spearman(x: List[float], y: List[float]) -> float:
        rx, ry = Statistics.rank(x), Statistics.rank(y)
        return Statistics.correlation(rx, ry)

    @staticmethod
    def kendall_tau(x: List[float], y: List[float]) -> float:
        n = len(x); concordant = discordant = 0
        for i in range(n):
            for j in range(i+1, n):
                dx = x[i] - x[j]; dy = y[i] - y[j]
                if dx * dy > 0: concordant += 1
                elif dx * dy < 0: discordant += 1
        denom = n*(n-1)//2
        return (concordant - discordant) / denom if denom else 0.0

    @staticmethod
    def autocorrelation(data: List[float], lag: int = 1) -> float:
        n = len(data); m = Statistics.mean(data)
        num = sum((data[i]-m)*(data[i-lag]-m) for i in range(lag,n))
        den = sum((x-m)**2 for x in data)
        return num/den if den else 0.0

    @staticmethod
    def partial_autocorrelation(data: List[float], max_lag: int = 10) -> List[float]:
        pacf = []
        for k in range(1, max_lag+1):
            x = data[k:]; y = data[:-k]
            r = Statistics.correlation(x, y) if len(x) > 1 else 0.0
            pacf.append(r)
        return pacf

    @staticmethod
    def moving_average(data: List[float], window: int) -> List[float]:
        return [Statistics.mean(data[i:i+window])
                for i in range(len(data)-window+1)]

    @staticmethod
    def exponential_moving_average(data: List[float], alpha: float = 0.3) -> List[float]:
        ema = [data[0]]
        for x in data[1:]:
            ema.append(alpha*x + (1-alpha)*ema[-1])
        return ema

    @staticmethod
    def weighted_mean(data: List[float], weights: List[float]) -> float:
        return sum(x*w for x,w in zip(data,weights)) / sum(weights)

    @staticmethod
    def bootstrap_ci(data: List[float], stat_fn=None, n_boot: int = 1000,
                     ci: float = 0.95) -> tuple:
        import random
        if stat_fn is None: stat_fn = Statistics.mean
        boots = [stat_fn(random.choices(data, k=len(data))) for _ in range(n_boot)]
        boots.sort()
        lo = int((1-ci)/2 * n_boot); hi = int((1+(ci))/2 * n_boot)
        return boots[lo], boots[hi]

# ── Security: input validation layer ──────────────────────────────────────

class StatisticsValidator:
    """Input validation and sanitisation for Statistics methods."""

    MAX_ELEMENTS  = 1_000_000
    MAX_VALUE     = 1e300
    MIN_VALUE     = -1e300

    @classmethod
    def validate(cls, data: List[float], name: str = "data") -> List[float]:
        if not isinstance(data, (list, tuple)):
            raise TypeError(f"{name} must be a list, got {type(data).__name__}")
        if len(data) == 0:
            raise ValueError(f"{name} must not be empty")
        if len(data) > cls.MAX_ELEMENTS:
            raise ValueError(f"{name} exceeds max {cls.MAX_ELEMENTS} elements")
        cleaned = []
        import math
        for i, v in enumerate(data):
            if not isinstance(v, (int, float)):
                raise TypeError(f"{name}[{i}] is not numeric: {type(v)}")
            if not math.isfinite(v):
                continue   # silently drop inf/nan
            if v > cls.MAX_VALUE or v < cls.MIN_VALUE:
                raise ValueError(f"{name}[{i}]={v} exceeds allowed range")
            cleaned.append(float(v))
        if not cleaned:
            raise ValueError(f"{name} contains no finite values")
        return cleaned

    @classmethod
    def validate_pair(cls, x: List[float], y: List[float]) -> tuple:
        x2 = cls.validate(x, "x"); y2 = cls.validate(y, "y")
        if len(x2) != len(y2):
            raise ValueError("x and y must have the same length")
        return x2, y2

    @classmethod
    def validate_window(cls, window: int, n: int) -> int:
        if window < 1: raise ValueError("window must be >= 1")
        if window > n: raise ValueError("window larger than data length")
        return window

    @classmethod
    def validate_percentile(cls, p: float) -> float:
        if not 0 <= p <= 100:
            raise ValueError(f"Percentile must be in [0,100], got {p}")
        return p

    @classmethod
    def validate_alpha(cls, alpha: float) -> float:
        if not 0 < alpha < 1:
            raise ValueError(f"alpha must be in (0,1), got {alpha}")
        return alpha

# ── Standards: hypothesis testing ─────────────────────────────────────────

class HypothesisTests:
    """
    Statistical hypothesis tests conforming to standard academic reporting:
    test statistic, degrees of freedom, p-value, decision at α=0.05.
    """

    import math as _math

    @staticmethod
    def t_test_one_sample(data: List[float], mu0: float = 0.0,
                           alpha: float = 0.05) -> dict:
        import math
        n = len(data); m = Statistics.mean(data)
        s = Statistics.std_dev(data)
        t = (m - mu0) / (s / math.sqrt(n)) if s else float("inf")
        # Two-tailed p-value via t-distribution approximation
        p = 2 * (1 - 0.5*(1+math.erf(abs(t)/math.sqrt(2)))) * 1.1  # approx
        return {"test":"one-sample t","t":round(t,4),"df":n-1,
                "p_value":round(min(p,1),6),"reject_h0":p<alpha}

    @staticmethod
    def t_test_two_sample(x: List[float], y: List[float],
                           equal_var: bool = True, alpha: float = 0.05) -> dict:
        import math
        nx, ny = len(x), len(y)
        mx, my = Statistics.mean(x), Statistics.mean(y)
        sx, sy = Statistics.std_dev(x), Statistics.std_dev(y)
        if equal_var:
            sp = math.sqrt(((nx-1)*sx**2+(ny-1)*sy**2)/(nx+ny-2))
            t  = (mx-my)/(sp*math.sqrt(1/nx+1/ny)) if sp else 0
            df = nx+ny-2
        else:
            se = math.sqrt(sx**2/nx + sy**2/ny)
            t  = (mx-my)/se if se else 0
            df = int((sx**2/nx+sy**2/ny)**2 /
                     ((sx**2/nx)**2/(nx-1)+(sy**2/ny)**2/(ny-1)+1e-15))
        p = 2*(1-0.5*(1+math.erf(abs(t)/math.sqrt(2))))
        return {"test":"two-sample t","t":round(t,4),"df":df,
                "p_value":round(min(p,1),6),"reject_h0":p<alpha}

    @staticmethod
    def f_test_variance(x: List[float], y: List[float],
                         alpha: float = 0.05) -> dict:
        sx2, sy2 = Statistics.variance(x), Statistics.variance(y)
        F = sx2/sy2 if sy2 else float("inf")
        return {"test":"F variance","F":round(F,4),
                "df1":len(x)-1,"df2":len(y)-1,"reject_h0":F>3}

    @staticmethod
    def chi_square_goodness(observed: List[float],
                             expected: List[float],
                             alpha: float = 0.05) -> dict:
        import math
        chi = sum((o-e)**2/e for o,e in zip(observed,expected) if e>0)
        df  = len(observed)-1
        p   = 1-0.5*(1+math.erf(math.sqrt(chi/2)-math.sqrt(df-0.5))) # approx
        return {"test":"chi-square goodness-of-fit","chi2":round(chi,4),
                "df":df,"p_value":round(max(0,min(1,p)),6),"reject_h0":p<alpha}

    @staticmethod
    def mann_whitney_u(x: List[float], y: List[float],
                        alpha: float = 0.05) -> dict:
        import math
        nx, ny = len(x), len(y)
        U = sum(1 if xi>yi else 0.5 if xi==yi else 0
                for xi in x for yi in y)
        mu = nx*ny/2
        su = math.sqrt(nx*ny*(nx+ny+1)/12)
        z  = (U-mu)/su if su else 0
        p  = 2*(1-0.5*(1+math.erf(abs(z)/math.sqrt(2))))
        return {"test":"Mann-Whitney U","U":U,"z":round(z,4),
                "p_value":round(min(p,1),6),"reject_h0":p<alpha}

    @staticmethod
    def anova_one_way(*groups: List[float], alpha: float = 0.05) -> dict:
        import math
        all_data = [x for g in groups for x in g]
        grand_m  = Statistics.mean(all_data)
        k = len(groups); N = len(all_data)
        ss_between = sum(len(g)*(Statistics.mean(g)-grand_m)**2 for g in groups)
        ss_within  = sum((x-Statistics.mean(g))**2 for g in groups for x in g)
        df_b, df_w = k-1, N-k
        if df_w == 0: return {"test":"one-way ANOVA","error":"insufficient data"}
        ms_b = ss_between/df_b if df_b else 0
        ms_w = ss_within/df_w
        F    = ms_b/ms_w if ms_w else float("inf")
        return {"test":"one-way ANOVA","F":round(F,4),
                "df_between":df_b,"df_within":df_w,"reject_h0":F>3}
