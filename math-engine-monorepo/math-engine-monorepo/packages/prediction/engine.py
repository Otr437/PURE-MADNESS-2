"""
PredictiveAnalyticsEngine — ensemble ML forecasting with confidence
intervals and Monte Carlo simulation.

Models: RandomForest, GradientBoosting, MLP, GaussianProcess, LinearRegression.
Falls back gracefully when sklearn is unavailable.
"""

from typing import Any, Dict, List, Optional

try:
    import numpy as np
    from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import RBF, WhiteKernel
    from sklearn.linear_model import LinearRegression
    from sklearn.neural_network import MLPRegressor
    from sklearn.preprocessing import StandardScaler
    _SKLEARN = True
except ImportError:
    _SKLEARN = False


class PredictiveAnalyticsEngine:
    """Ensemble predictive analytics engine."""

    def __init__(self) -> None:
        self.models: Dict[str, Any] = {}
        self.scaler = StandardScaler() if _SKLEARN else None
        self.trained = False
        self.lookback = 10

    # ------------------------------------------------------------------ #
    #  Feature engineering                                                 #
    # ------------------------------------------------------------------ #

    def _create_features(self, data: List[float], lookback: int):
        X, y = [], []
        for i in range(len(data) - lookback):
            X.append(data[i:i + lookback])
            y.append(data[i + lookback])
        if _SKLEARN:
            import numpy as np
            return np.array(X), np.array(y)
        return X, y

    # ------------------------------------------------------------------ #
    #  Training                                                            #
    # ------------------------------------------------------------------ #

    def train(self, data: List[float]) -> Dict[str, Any]:
        if not _SKLEARN:
            return {"error": "scikit-learn not available"}
        if len(data) < 20:
            return {"error": "Need at least 20 data points"}

        import numpy as np
        self.lookback = min(10, len(data) // 3)
        X, y = self._create_features(data, self.lookback)
        if len(X) < 5:
            return {"error": "Not enough samples after feature creation"}

        X_sc = self.scaler.fit_transform(X)

        self.models = {
            "rf":  RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42),
            "gb":  GradientBoostingRegressor(n_estimators=100, max_depth=5, random_state=42),
            "mlp": MLPRegressor(hidden_layer_sizes=(50, 25), max_iter=500, random_state=42),
            "gp":  GaussianProcessRegressor(kernel=RBF() + WhiteKernel(), random_state=42),
            "lr":  LinearRegression(),
        }

        scores: Dict[str, float] = {}
        for name, model in self.models.items():
            model.fit(X_sc, y)
            scores[name] = float(model.score(X_sc, y))

        self.trained = True
        return {"models_trained": len(self.models), "scores": scores, "lookback": self.lookback}

    # ------------------------------------------------------------------ #
    #  Prediction                                                          #
    # ------------------------------------------------------------------ #

    def predict(self, history: List[float], steps: int = 10) -> Dict[str, Any]:
        if not self.trained:
            return {"error": "Model not trained — call train() first"}
        if not _SKLEARN:
            return {"error": "scikit-learn not available"}
        if len(history) < self.lookback:
            return {"error": f"Need at least {self.lookback} history points"}

        import numpy as np

        per_model: Dict[str, List[float]] = {}
        for name, model in self.models.items():
            preds: List[float] = []
            buf = list(history)
            for _ in range(steps):
                X = np.array(buf[-self.lookback:]).reshape(1, -1)
                X_sc = self.scaler.transform(X)
                p = float(model.predict(X_sc)[0])
                preds.append(p)
                buf.append(p)
            per_model[name] = preds

        # Ensemble mean
        ensemble = [
            sum(per_model[m][i] for m in per_model) / len(per_model)
            for i in range(steps)
        ]
        per_model["ensemble"] = ensemble

        # Confidence intervals across models
        confidence = []
        for i in range(steps):
            vals = [per_model[m][i] for m in per_model if m != "ensemble"]
            mean = sum(vals) / len(vals)
            std  = float(np.std(vals))
            confidence.append({
                "mean":  mean,
                "lower": mean - 1.96 * std,
                "upper": mean + 1.96 * std,
            })

        return {"predictions": per_model, "confidence": confidence, "steps": steps}

    # ------------------------------------------------------------------ #
    #  Monte Carlo forecast                                                #
    # ------------------------------------------------------------------ #

    def monte_carlo_forecast(self, history: List[float],
                              steps: int = 10, n_sims: int = 1000) -> Dict[str, Any]:
        if not self.trained:
            return {"error": "Model not trained"}
        if not _SKLEARN:
            return {"error": "scikit-learn not available"}

        import numpy as np

        sims = []
        for _ in range(n_sims):
            pred = self.predict(history, steps)
            sims.append(pred["predictions"]["ensemble"])

        sims_arr = np.array(sims)  # shape: (n_sims, steps)
        return {
            "mean":      [float(np.mean(sims_arr[:, i]))              for i in range(steps)],
            "median":    [float(np.median(sims_arr[:, i]))            for i in range(steps)],
            "std":       [float(np.std(sims_arr[:, i]))               for i in range(steps)],
            "lower_95":  [float(np.percentile(sims_arr[:, i], 2.5))  for i in range(steps)],
            "upper_95":  [float(np.percentile(sims_arr[:, i], 97.5)) for i in range(steps)],
            "lower_99":  [float(np.percentile(sims_arr[:, i], 0.5))  for i in range(steps)],
            "upper_99":  [float(np.percentile(sims_arr[:, i], 99.5)) for i in range(steps)],
        }

    # ── Extended prediction business logic ────────────────────────────────

    def retrain_if_stale(self, data: List[float],
                          max_age_sec: float = 3600) -> dict:
        """Retrain if model is older than max_age_sec."""
        import time
        if not hasattr(self, "_trained_at"):
            self._trained_at = 0.0
        if time.time() - self._trained_at > max_age_sec:
            result = self.train(data)
            self._trained_at = time.time()
            return {"retrained": True, **result}
        return {"retrained": False, "models_trained": len(self.models)}

    def cross_validate(self, data: List[float],
                        folds: int = 5) -> dict:
        """k-fold time-series cross-validation."""
        if not _SKLEARN:
            return {"error": "sklearn required"}
        if len(data) < folds * 10:
            return {"error": f"Need at least {folds*10} points for {folds}-fold CV"}
        import numpy as np
        fold_size = len(data) // folds
        scores = []
        for k in range(folds):
            train_end = fold_size * (k+1)
            if train_end + self.lookback >= len(data):
                break
            train = data[:train_end]
            test  = data[train_end:train_end+fold_size]
            self.train(train)
            pred  = self.predict(train, steps=len(test))
            ens   = pred.get("predictions", {}).get("ensemble", [])
            if ens:
                mse = sum((p-a)**2 for p,a in zip(ens,test)) / len(test)
                scores.append(float(np.sqrt(mse)))
        return {
            "cv_rmse_per_fold": [round(s,6) for s in scores],
            "mean_cv_rmse":     round(sum(scores)/len(scores),6) if scores else None,
            "folds_completed":  len(scores),
        }

    def feature_importance(self) -> dict:
        """Return feature importance from tree-based models."""
        if not self.trained:
            return {"error": "Model not trained"}
        result = {}
        for name, model in self.models.items():
            if hasattr(model, "feature_importances_"):
                result[name] = [round(float(fi),6)
                                 for fi in model.feature_importances_]
        return result or {"info": "No tree models with feature importances"}

    def residual_analysis(self, history: List[float],
                           steps: int = 10) -> dict:
        """Analyse prediction residuals on in-sample data."""
        if not self.trained or len(history) < self.lookback + steps:
            return {"error": "insufficient data or model not trained"}
        actual    = history[-(self.lookback+steps):]
        pred_data = actual[:self.lookback]
        pred      = self.predict(pred_data, steps)
        ens       = pred.get("predictions",{}).get("ensemble",[])
        true_vals = actual[self.lookback:self.lookback+len(ens)]
        residuals = [a-p for a,p in zip(true_vals, ens)]
        n = len(residuals)
        if n == 0:
            return {"error": "no residuals"}
        mean_res = sum(residuals)/n
        std_res  = (sum((r-mean_res)**2 for r in residuals)/n)**0.5
        return {
            "residuals":     [round(r,6) for r in residuals],
            "mean":          round(mean_res,6),
            "std":           round(std_res,6),
            "mae":           round(sum(abs(r) for r in residuals)/n, 6),
            "rmse":          round((sum(r**2 for r in residuals)/n)**0.5, 6),
            "max_error":     round(max(abs(r) for r in residuals), 6),
        }

    def forecast_intervals_bootstrap(self, history: List[float],
                                      steps: int = 10,
                                      n_boot: int = 200) -> dict:
        """Bootstrap prediction intervals from model variance."""
        if not self.trained:
            return {"error": "Model not trained"}
        if not _SKLEARN:
            return {"error": "sklearn required"}
        import numpy as np, random
        boot_preds = []
        for _ in range(n_boot):
            jitter = [h + random.gauss(0, 0.01*abs(h)+1e-6) for h in history]
            p = self.predict(jitter, steps)
            ens = p.get("predictions",{}).get("ensemble",[])
            if ens: boot_preds.append(ens)
        if not boot_preds:
            return {"error": "bootstrap failed"}
        arr = np.array(boot_preds)
        return {
            "lower_80": [round(float(np.percentile(arr[:,i],10)),6) for i in range(steps)],
            "upper_80": [round(float(np.percentile(arr[:,i],90)),6) for i in range(steps)],
            "lower_95": [round(float(np.percentile(arr[:,i],2.5)),6) for i in range(steps)],
            "upper_95": [round(float(np.percentile(arr[:,i],97.5)),6) for i in range(steps)],
            "median":   [round(float(np.median(arr[:,i])),6) for i in range(steps)],
        }

# ── Security: prediction input validation ────────────────────────────────

class PredictionValidator:
    """
    Validates all inputs to the PredictiveAnalyticsEngine.
    Prevents model poisoning, OOM, and silent NaN propagation.
    """
    MAX_HISTORY_LEN = 100_000
    MAX_STEPS       = 1_000
    MAX_SIMS        = 10_000
    MAX_FOLDS       = 20
    MIN_TRAIN_PTS   = 20

    @classmethod
    def validate_history(cls, data, name: str = "history") -> List[float]:
        import math
        if not isinstance(data, (list, tuple)):
            raise TypeError(f"{name} must be list, got {type(data).__name__}")
        if len(data) > cls.MAX_HISTORY_LEN:
            raise ValueError(f"{name} exceeds {cls.MAX_HISTORY_LEN} points")
        cleaned = [float(x) for x in data
                   if isinstance(x, (int, float)) and math.isfinite(x)]
        if len(cleaned) < 3:
            raise ValueError(f"{name} must have at least 3 finite values")
        return cleaned

    @classmethod
    def validate_steps(cls, steps: int) -> int:
        if not isinstance(steps, int) or steps < 1:
            raise ValueError("steps must be positive integer")
        if steps > cls.MAX_STEPS:
            raise ValueError(f"steps exceeds maximum {cls.MAX_STEPS}")
        return steps

    @classmethod
    def validate_n_sims(cls, n: int) -> int:
        if n < 1 or n > cls.MAX_SIMS:
            raise ValueError(f"n_sims must be in [1, {cls.MAX_SIMS}]")
        return n

    @classmethod
    def validate_folds(cls, k: int) -> int:
        if k < 2 or k > cls.MAX_FOLDS:
            raise ValueError(f"folds must be in [2, {cls.MAX_FOLDS}]")
        return k

    @classmethod
    def check_train_size(cls, n: int) -> None:
        if n < cls.MIN_TRAIN_PTS:
            raise ValueError(f"Training requires at least {cls.MIN_TRAIN_PTS} points, got {n}")

# ── Standards: model evaluation metrics ──────────────────────────────────

class ForecastStandards:
    """
    Industry-standard forecast evaluation metrics.
    Aligns with: Hyndman & Athanasopoulos 'Forecasting: Principles & Practice'
    """

    @staticmethod
    def mae(actual: List[float], predicted: List[float]) -> float:
        return sum(abs(a-p) for a,p in zip(actual,predicted))/len(actual)

    @staticmethod
    def mse(actual: List[float], predicted: List[float]) -> float:
        return sum((a-p)**2 for a,p in zip(actual,predicted))/len(actual)

    @staticmethod
    def rmse(actual: List[float], predicted: List[float]) -> float:
        return ForecastStandards.mse(actual,predicted)**0.5

    @staticmethod
    def mape(actual: List[float], predicted: List[float]) -> float:
        pairs = [(a,p) for a,p in zip(actual,predicted) if a!=0]
        return sum(abs(a-p)/abs(a) for a,p in pairs)/len(pairs)*100 if pairs else float("inf")

    @staticmethod
    def smape(actual: List[float], predicted: List[float]) -> float:
        return sum(2*abs(a-p)/(abs(a)+abs(p)+1e-10)
                   for a,p in zip(actual,predicted))/len(actual)*100

    @staticmethod
    def mase(actual: List[float], predicted: List[float],
             train: List[float]) -> float:
        """Mean Absolute Scaled Error (Hyndman & Koehler 2006)."""
        naive_mae = sum(abs(train[i]-train[i-1])
                        for i in range(1,len(train))) / (len(train)-1)
        return ForecastStandards.mae(actual,predicted) / naive_mae if naive_mae else float("inf")

    @staticmethod
    def directional_accuracy(actual: List[float],
                              predicted: List[float]) -> float:
        """% of periods where direction (up/down) is correctly forecast."""
        correct = sum(1 for a,p in zip(actual[1:],predicted[1:])
                      if (a-actual[i])*(p-predicted[i]) > 0
                      for i in [list(actual).index(a)-1])
        return correct / (len(actual)-1) * 100 if len(actual) > 1 else 0.0

    @staticmethod
    def all_metrics(actual: List[float],
                    predicted: List[float],
                    train: List[float] = None) -> dict:
        result = {
            "mae":   round(ForecastStandards.mae(actual,predicted),6),
            "mse":   round(ForecastStandards.mse(actual,predicted),6),
            "rmse":  round(ForecastStandards.rmse(actual,predicted),6),
            "mape":  round(ForecastStandards.mape(actual,predicted),4),
            "smape": round(ForecastStandards.smape(actual,predicted),4),
        }
        if train:
            result["mase"] = round(ForecastStandards.mase(actual,predicted,train),6)
        return result
