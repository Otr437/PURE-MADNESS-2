"""
AnalyticsEngine — descriptive statistics, distribution tests, outlier
detection, correlation analysis, and time-series decomposition.
Uses scipy when available, falls back to pure-Python implementations.
"""

import math
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

try:
    import numpy as np
    from scipy import stats as scipy_stats
    from scipy.fft import fft, fftfreq
    _SCIPY = True
except ImportError:
    _SCIPY = False


class AnalyticsEngine:
    """Statistical analytics engine."""

    # ------------------------------------------------------------------ #
    #  Descriptive statistics                                              #
    # ------------------------------------------------------------------ #

    def descriptive_stats(self, data: List[float]) -> Dict[str, Any]:
        if not data:
            return {"error": "No data"}

        if _SCIPY:
            arr = np.array(data, dtype=float)
            arr = arr[np.isfinite(arr)]
            if len(arr) == 0:
                return {"error": "No finite values"}
            return {
                "count":    int(len(arr)),
                "mean":     float(np.mean(arr)),
                "median":   float(np.median(arr)),
                "mode":     float(scipy_stats.mode(arr, keepdims=True)[0][0]),
                "std":      float(np.std(arr, ddof=1)),
                "variance": float(np.var(arr, ddof=1)),
                "min":      float(np.min(arr)),
                "max":      float(np.max(arr)),
                "range":    float(np.max(arr) - np.min(arr)),
                "q1":       float(np.percentile(arr, 25)),
                "q3":       float(np.percentile(arr, 75)),
                "iqr":      float(np.percentile(arr, 75) - np.percentile(arr, 25)),
                "skew":     float(scipy_stats.skew(arr)),
                "kurtosis": float(scipy_stats.kurtosis(arr)),
                "cv":       float(np.std(arr) / np.mean(arr)) if np.mean(arr) != 0 else 0,
            }

        # Pure-Python fallback
        arr = [x for x in data if math.isfinite(x)]
        n   = len(arr)
        if n == 0:
            return {"error": "No finite values"}
        mean    = sum(arr) / n
        sorted_ = sorted(arr)
        median  = (sorted_[n//2 - 1] + sorted_[n//2]) / 2 if n % 2 == 0 else sorted_[n//2]
        var     = sum((x - mean) ** 2 for x in arr) / max(n - 1, 1)
        std     = math.sqrt(var)
        q1, q3  = sorted_[n // 4], sorted_[3 * n // 4]
        return {
            "count": n, "mean": mean, "median": median,
            "std": std, "variance": var,
            "min": min(arr), "max": max(arr),
            "range": max(arr) - min(arr),
            "q1": q1, "q3": q3, "iqr": q3 - q1,
        }

    # ------------------------------------------------------------------ #
    #  Distribution tests                                                  #
    # ------------------------------------------------------------------ #

    def distribution_test(self, data: List[float]) -> Dict[str, Any]:
        if len(data) < 3:
            return {"error": "Need at least 3 data points"}
        if not _SCIPY:
            return {"error": "scipy required for distribution tests"}

        arr    = np.array(data)
        result: Dict[str, Any] = {}

        if 3 <= len(arr) <= 5000:
            stat, p = scipy_stats.shapiro(arr)
            result["shapiro_wilk"] = {
                "statistic": float(stat),
                "p_value":   float(p),
                "normal":    bool(p > 0.05),
            }

        if len(arr) >= 20:
            stat, p = scipy_stats.normaltest(arr)
            result["dagostino_pearson"] = {
                "statistic": float(stat),
                "p_value":   float(p),
                "normal":    bool(p > 0.05),
            }

        # Anderson-Darling
        ad = scipy_stats.anderson(arr)
        result["anderson_darling"] = {
            "statistic":        float(ad.statistic),
            "critical_values":  ad.critical_values.tolist(),
            "significance_levels": ad.significance_level.tolist(),
        }

        return result

    # ------------------------------------------------------------------ #
    #  Outlier detection                                                   #
    # ------------------------------------------------------------------ #

    def outlier_detection(self, data: List[float], method: str = "iqr") -> Dict[str, Any]:
        if _SCIPY:
            arr = np.array(data, dtype=float)
            arr = arr[np.isfinite(arr)]
        else:
            arr_list = [x for x in data if math.isfinite(x)]

        if method == "iqr":
            if _SCIPY:
                q1, q3 = float(np.percentile(arr, 25)), float(np.percentile(arr, 75))
                iqr     = q3 - q1
                mask    = (arr < q1 - 1.5 * iqr) | (arr > q3 + 1.5 * iqr)
                outliers = arr[mask].tolist()
            else:
                sorted_ = sorted(arr_list)
                n       = len(sorted_)
                q1, q3  = sorted_[n // 4], sorted_[3 * n // 4]
                iqr     = q3 - q1
                outliers = [x for x in arr_list if x < q1 - 1.5 * iqr or x > q3 + 1.5 * iqr]

        elif method == "zscore":
            if _SCIPY:
                zs       = np.abs(scipy_stats.zscore(arr))
                outliers = arr[zs > 3].tolist()
            else:
                mean = sum(arr_list) / len(arr_list)
                std  = math.sqrt(sum((x - mean) ** 2 for x in arr_list) / len(arr_list))
                outliers = [x for x in arr_list if std > 0 and abs(x - mean) / std > 3]

        else:
            outliers = []

        total = len(arr.tolist() if _SCIPY else arr_list)
        return {
            "method":     method,
            "outliers":   outliers,
            "count":      len(outliers),
            "percentage": len(outliers) / total * 100 if total else 0,
        }

    # ------------------------------------------------------------------ #
    #  Correlation                                                         #
    # ------------------------------------------------------------------ #

    def correlation(self, x: List[float], y: List[float]) -> Dict[str, Any]:
        if len(x) != len(y) or len(x) < 2:
            return {"error": "Invalid data"}
        if not _SCIPY:
            return {"error": "scipy required for correlation"}
        pr, pp = scipy_stats.pearsonr(x, y)
        sr, sp = scipy_stats.spearmanr(x, y)
        return {
            "pearson":  {"r": float(pr), "p_value": float(pp)},
            "spearman": {"rho": float(sr), "p_value": float(sp)},
        }

    # ------------------------------------------------------------------ #
    #  Time-series decomposition                                           #
    # ------------------------------------------------------------------ #

    def time_series_decompose(self, data: List[float],
                               period: Optional[int] = None) -> Dict[str, Any]:
        if not _SCIPY:
            return {"error": "numpy/scipy required"}

        arr = np.array(data, dtype=float)
        n   = len(arr)
        if period is None:
            period = max(2, n // 10)

        # Trend via moving average
        trend = np.convolve(arr, np.ones(period) / period, mode="same")

        # Dominant frequency via FFT
        detrended = arr - trend
        fft_vals  = fft(detrended)
        freqs     = fftfreq(n)
        magnitude = np.abs(fft_vals)
        if n > 1:
            dom_idx     = int(np.argmax(magnitude[1:])) + 1
            dom_freq    = freqs[dom_idx]
            seasonal_p  = int(1 / dom_freq) if dom_freq > 0 else period
        else:
            seasonal_p  = period

        residual = detrended - float(np.mean(detrended))

        return {
            "trend":           trend.tolist(),
            "residual":        residual.tolist(),
            "seasonal_period": seasonal_p,
        }

    # ------------------------------------------------------------------ #
    #  Bayesian inference (basic)                                          #
    # ------------------------------------------------------------------ #

    def bayesian_update(self, prior: float, likelihood: float,
                         evidence: float) -> float:
        """P(H|E) = P(E|H) * P(H) / P(E)"""
        if evidence == 0:
            raise ZeroDivisionError("Evidence probability cannot be zero")
        return likelihood * prior / evidence

    # ── Extended analytics ────────────────────────────────────────────────

    def regression_analysis(self, x: List[float], y: List[float]) -> dict:
        """Full OLS regression with residuals, R², and F-stat."""
        if len(x) != len(y) or len(x) < 2:
            return {"error": "Need paired x,y with n>=2"}
        n   = len(x)
        sx  = sum(x); sy = sum(y)
        sxy = sum(xi*yi for xi,yi in zip(x,y))
        sx2 = sum(xi**2 for xi in x)
        b   = (n*sxy - sx*sy) / (n*sx2 - sx**2) if (n*sx2 - sx**2) else 0
        a   = (sy - b*sx) / n
        y_hat    = [a + b*xi for xi in x]
        residuals= [yi - yhi for yi, yhi in zip(y, y_hat)]
        ss_res   = sum(r**2 for r in residuals)
        ss_tot   = sum((yi - sy/n)**2 for yi in y)
        r2       = 1 - ss_res/ss_tot if ss_tot else 0
        mse      = ss_res / (n-2) if n > 2 else 0
        se_b     = (mse / (sx2 - sx**2/n))**0.5 if sx2 - sx**2/n else 0
        t_b      = b / se_b if se_b else 0
        f_stat   = (r2 / 1) / ((1-r2)/(n-2)) if n > 2 and r2 < 1 else 0
        return {
            "intercept": round(a, 8), "slope": round(b, 8),
            "r_squared": round(r2, 6), "mse": round(mse, 8),
            "se_slope":  round(se_b, 8), "t_slope": round(t_b, 4),
            "f_stat":    round(f_stat, 4),
            "residuals": [round(r, 6) for r in residuals],
        }

    def polynomial_regression(self, x: List[float], y: List[float],
                               degree: int = 2) -> dict:
        """Fit polynomial of given degree via normal equations."""
        if not _SCIPY:
            return {"error": "numpy required"}
        import numpy as np
        X = np.vander(np.array(x), degree+1, increasing=True)
        XtX = X.T @ X; Xty = X.T @ np.array(y)
        try:
            coeffs = np.linalg.solve(XtX, Xty).tolist()
        except np.linalg.LinAlgError:
            return {"error": "singular matrix"}
        y_hat  = (X @ np.array(coeffs)).tolist()
        ss_res = sum((yi-yhi)**2 for yi,yhi in zip(y,y_hat))
        ss_tot = sum((yi-sum(y)/len(y))**2 for yi in y)
        r2     = 1-ss_res/ss_tot if ss_tot else 0
        return {"coefficients": [round(c,8) for c in coeffs],
                "r_squared": round(r2,6), "degree": degree}

    def moving_stats(self, data: List[float], window: int) -> dict:
        """Rolling mean, std, min, max."""
        if window < 1 or window > len(data):
            return {"error": "invalid window"}
        means, stds, mins, maxs = [], [], [], []
        for i in range(len(data)-window+1):
            w = data[i:i+window]
            means.append(round(sum(w)/window, 6))
            mean_ = sum(w)/window
            stds.append(round((sum((x-mean_)**2 for x in w)/window)**0.5, 6))
            mins.append(min(w)); maxs.append(max(w))
        return {"mean":means,"std":stds,"min":mins,"max":maxs}

    def correlation_matrix(self, datasets: dict) -> dict:
        """Pearson correlation matrix for named datasets."""
        if not _SCIPY:
            return {"error": "scipy required"}
        keys = list(datasets.keys())
        n    = len(keys)
        matrix = {}
        for i, ki in enumerate(keys):
            matrix[ki] = {}
            for j, kj in enumerate(keys):
                if i == j:
                    matrix[ki][kj] = 1.0
                else:
                    try:
                        from scipy.stats import pearsonr
                        r, _ = pearsonr(datasets[ki], datasets[kj])
                        matrix[ki][kj] = round(r, 6)
                    except Exception:
                        matrix[ki][kj] = None
        return matrix

    def grubbs_test(self, data: List[float], alpha: float = 0.05) -> dict:
        """Grubbs' test for single outlier."""
        import math
        n = len(data)
        if n < 3: return {"error": "Need n>=3"}
        m   = sum(data)/n
        s   = (sum((x-m)**2 for x in data)/(n-1))**0.5 if n>1 else 0
        G   = max(abs(x-m)/s for x in data) if s else 0
        # Critical value approx
        t_crit = 2.0   # rough, replace with t-table for production
        G_crit = ((n-1)/math.sqrt(n)) * math.sqrt(t_crit**2/(n-2+t_crit**2))
        idx    = max(range(n), key=lambda i: abs(data[i]-m))
        return {"G_stat": round(G,4), "G_crit": round(G_crit,4),
                "outlier_index": idx, "outlier_value": data[idx],
                "is_outlier": G > G_crit}

    def benford_test(self, data: List[float]) -> dict:
        """Benford's Law first-digit frequency analysis."""
        import math
        counts = [0]*9
        for x in data:
            d = int(str(abs(x)).lstrip("0").lstrip(".")[0]) if x != 0 else 0
            if 1 <= d <= 9: counts[d-1] += 1
        n = sum(counts)
        expected = [math.log10(1+1/d) for d in range(1,10)]
        observed = [c/n for c in counts]
        chi2 = sum((o-e)**2/e for o,e in zip(observed,expected) if e>0) * n
        return {
            "observed_freq": [round(o,4) for o in observed],
            "expected_freq": [round(e,4) for e in expected],
            "chi2_stat":     round(chi2,4),
            "conforms":      chi2 < 15.5,  # approx critical at α=0.05, df=8
        }

    def pca_summary(self, data: List[List[float]]) -> dict:
        """Principal Component Analysis via covariance matrix."""
        if not _SCIPY:
            return {"error": "numpy required"}
        import numpy as np
        X  = np.array(data, dtype=float)
        Xc = X - X.mean(axis=0)
        cov = np.cov(Xc, rowvar=False)
        evals, evecs = np.linalg.eigh(cov)
        idx = np.argsort(evals)[::-1]
        evals = evals[idx]; evecs = evecs[:,idx]
        total = sum(evals)
        variance_ratio = (evals/total).tolist() if total else []
        return {
            "eigenvalues":      [round(float(e),6) for e in evals],
            "variance_ratio":   [round(float(v),6) for v in variance_ratio],
            "cumulative_var":   [round(sum(variance_ratio[:i+1]),6)
                                  for i in range(len(variance_ratio))],
            "n_components":     len(evals),
        }

# ── Security: input validation ────────────────────────────────────────────

class AnalyticsInputValidator:
    """
    Validates and sanitises all analytics inputs.
    Prevents OOM from huge datasets, type confusion, and NaN propagation.
    """
    MAX_POINTS    = 1_000_000
    MAX_DATASETS  = 100
    MAX_DEGREE    = 20
    MAX_WINDOW    = 100_000

    @classmethod
    def validate_series(cls, data, name: str = "data") -> List[float]:
        import math
        if not isinstance(data, (list, tuple)):
            raise TypeError(f"{name} must be list/tuple")
        if len(data) > cls.MAX_POINTS:
            raise ValueError(f"{name} exceeds {cls.MAX_POINTS} points")
        cleaned = [float(x) for x in data if isinstance(x,(int,float))
                   and math.isfinite(x)]
        if not cleaned:
            raise ValueError(f"{name}: no finite values")
        return cleaned

    @classmethod
    def validate_matrix(cls, data) -> List[List[float]]:
        import math
        if not isinstance(data, (list,tuple)):
            raise TypeError("data must be a list of lists")
        n_cols = len(data[0]) if data else 0
        result = []
        for i, row in enumerate(data):
            if len(row) != n_cols:
                raise ValueError(f"Row {i} has inconsistent length")
            result.append([float(x) for x in row if math.isfinite(x)])
        return result

    @classmethod
    def validate_regression_degree(cls, d: int) -> int:
        if d < 1 or d > cls.MAX_DEGREE:
            raise ValueError(f"Polynomial degree must be 1–{cls.MAX_DEGREE}")
        return d

    @classmethod
    def validate_window(cls, w: int, n: int) -> int:
        if w < 1: raise ValueError("Window must be >= 1")
        if w > min(n, cls.MAX_WINDOW):
            raise ValueError(f"Window {w} too large for n={n}")
        return w

    @classmethod
    def sanitise_for_json(cls, obj):
        """Recursively replace non-JSON-serialisable values."""
        import math
        if isinstance(obj, float):
            if math.isnan(obj):  return None
            if math.isinf(obj):  return str(obj)
            return obj
        if isinstance(obj, dict):  return {k: cls.sanitise_for_json(v) for k,v in obj.items()}
        if isinstance(obj, list):  return [cls.sanitise_for_json(v) for v in obj]
        return obj

# ── Standards: analytics reporting format ────────────────────────────────

class AnalyticsReport:
    """
    Standardised analytics report builder.
    Follows APA 7th Edition statistical reporting conventions.
    """

    @staticmethod
    def format_p_value(p: float) -> str:
        if p < 0.001: return "p < .001"
        if p < 0.01:  return f"p = {p:.3f}"
        return f"p = {p:.2f}"

    @staticmethod
    def format_ci(lo: float, hi: float, ci: float = 0.95) -> str:
        pct = int(ci*100)
        return f"{pct}% CI [{lo:.4f}, {hi:.4f}]"

    @staticmethod
    def significance_stars(p: float) -> str:
        if p < 0.001: return "***"
        if p < 0.01:  return "**"
        if p < 0.05:  return "*"
        return "ns"

    @staticmethod
    def descriptive_summary(stats: dict) -> str:
        return (f"M = {stats.get('mean',0):.4f}, "
                f"SD = {stats.get('std',0):.4f}, "
                f"Mdn = {stats.get('median',0):.4f}, "
                f"n = {stats.get('count',0)}")

    @staticmethod
    def effect_size_label(cohens_d: float) -> str:
        d = abs(cohens_d)
        if d < 0.2:  return "negligible"
        if d < 0.5:  return "small"
        if d < 0.8:  return "medium"
        return "large"

    @staticmethod
    def cohens_d(x: List[float], y: List[float]) -> float:
        import math
        n1,n2 = len(x),len(y)
        m1,m2 = sum(x)/n1, sum(y)/n2
        s1 = (sum((v-m1)**2 for v in x)/(n1-1))**0.5 if n1>1 else 0
        s2 = (sum((v-m2)**2 for v in y)/(n2-1))**0.5 if n2>1 else 0
        sp = math.sqrt(((n1-1)*s1**2+(n2-1)*s2**2)/(n1+n2-2)) if n1+n2>2 else 1
        return (m1-m2)/sp if sp else 0
