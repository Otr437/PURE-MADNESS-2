"""
Configuration schemas — dataclass definitions for every subsystem.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class DatabaseConfig:
    path: str = "math_engine.db"
    pool_size: int = 10
    timeout: float = 30.0
    journal_mode: str = "WAL"
    cache_size: int = -20000
    encrypt_key: Optional[str] = None
    backup_interval: int = 3600
    max_backups: int = 5
    vacuum_on_close: bool = True


@dataclass
class SecurityConfig:
    max_input_length: int = 100_000
    max_memory_mb: int = 1024
    max_execution_time: float = 60.0
    sandbox_enabled: bool = True
    allowed_modules: List[str] = field(
        default_factory=lambda: ["math", "cmath", "sympy", "numpy", "scipy"]
    )
    blocked_functions: List[str] = field(
        default_factory=lambda: ["eval", "exec", "__import__", "open", "file", "compile"]
    )
    rate_limit_per_ip: int = 100
    rate_limit_window: int = 60
    api_key_required: bool = False
    api_keys: Dict[str, str] = field(default_factory=dict)
    ssl_cert_path: Optional[str] = None
    ssl_key_path: Optional[str] = None
    audit_logging: bool = True
    anomaly_detection_threshold: float = 3.0


@dataclass
class MemoryConfig:
    total_size: int = 100 * 1024 * 1024
    pointer_size: int = 8
    page_size: int = 4096
    bounds_checking: bool = True
    null_checking: bool = True
    use_mmap: bool = False
    persist_to_disk: bool = True
    gc_interval: int = 60
    alignment: int = 8
    random_allocation: bool = True
    allocation_strategy: str = "first_fit"


@dataclass
class PrecisionConfig:
    decimal_places: int = 100
    symbolic_by_default: bool = True
    high_precision_always: bool = False
    epsilon: float = 1e-15
    complex_tolerance: float = 1e-12
    matrix_epsilon: float = 1e-10
    adaptive_precision: bool = True
    max_precision: int = 1000


@dataclass
class GodModeConfig:
    enabled: bool = True
    timeout: float = 60.0
    max_iterations: int = 100_000
    heuristic_depth: int = 1000
    use_z3_prover: bool = False
    use_sympy_prover: bool = True
    auto_discover_theorems: bool = True
    theorem_database: str = "theorems.json"
    proof_verification: bool = True
    random_theorem_search: bool = True
    theorem_discovery_rate: float = 0.1
    max_theorems: int = 10_000


@dataclass
class AnalyticsConfig:
    enabled: bool = True
    max_data_points: int = 10_000
    distribution_fitting: bool = True
    hypothesis_testing: bool = True
    bayesian_inference: bool = True
    confidence_level: float = 0.95
    outlier_method: str = "iqr"
    time_series_analysis: bool = True
    correlation_methods: List[str] = field(
        default_factory=lambda: ["pearson", "spearman", "kendall"]
    )


@dataclass
class PredictionConfig:
    enabled: bool = True
    default_horizon: int = 10
    ensemble_models: List[str] = field(
        default_factory=lambda: ["rf", "gb", "gp", "mlp", "svr"]
    )
    auto_retrain: bool = True
    retrain_interval: int = 3600
    validation_split: float = 0.2
    random_search_iterations: int = 50
    cross_validation_folds: int = 5
    feature_lookback: int = 10


@dataclass
class RandomizationConfig:
    enabled: bool = True
    entropy_sources: List[str] = field(
        default_factory=lambda: ["quantum", "chaos", "thermal", "timing"]
    )
    chaos_dimension: int = 3
    quantum_bits: int = 256
    use_hardware_rng: bool = False
    prediction_noise: float = 0.1
    random_math_depth: int = 5
    random_matrix_size: int = 10


@dataclass
class LoggingConfig:
    level: str = "INFO"
    file: str = "math_engine.log"
    max_size_mb: int = 100
    backup_count: int = 10
    format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    json_format: bool = False
    send_alerts: bool = True
    alert_webhook: Optional[str] = None
    alert_threshold: str = "ERROR"
    log_queries: bool = True
    log_performance: bool = True


@dataclass
class APIConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    workers: int = 4
    cors_enabled: bool = True
    cors_origins: List[str] = field(default_factory=lambda: ["*"])
    rate_limit_enabled: bool = True
    websocket_enabled: bool = True
    graphql_enabled: bool = False
    max_request_size_mb: int = 10
    compression_enabled: bool = True
    ssl_enabled: bool = False
    jwt_secret: Optional[str] = None
    jwt_expiry_hours: int = 24


@dataclass
class AdminConfig:
    enabled: bool = True
    port: int = 8081
    host: str = "127.0.0.1"
    username: str = "admin"
    password_hash: str = ""
    require_auth: bool = True
    session_timeout: int = 3600
    theme: str = "dark"


# ── Extended schema helpers ───────────────────────────────────────────────

from dataclasses import asdict
from typing import Any, Dict


def schema_to_dict(cfg) -> Dict[str, Any]:
    """Recursively convert dataclass config to plain dict."""
    if hasattr(cfg, "__dataclass_fields__"):
        return {k: schema_to_dict(v) for k, v in asdict(cfg).items()}
    if isinstance(cfg, dict):
        return {k: schema_to_dict(v) for k, v in cfg.items()}
    if isinstance(cfg, list):
        return [schema_to_dict(v) for v in cfg]
    return cfg


def schema_diff(a, b) -> Dict[str, Any]:
    """Return keys that differ between two config dataclasses."""
    da, db = schema_to_dict(a), schema_to_dict(b)
    return {k: {"from": da.get(k), "to": db.get(k)}
            for k in set(da) | set(db) if da.get(k) != db.get(k)}


def validate_schema_types(cfg) -> List[str]:
    """
    Walk a config dataclass and verify each field matches its annotated type.
    Returns list of violation messages.
    """
    import typing
    violations = []
    if not hasattr(cfg, "__dataclass_fields__"):
        return violations
    hints = typing.get_type_hints(type(cfg))
    for field, hint in hints.items():
        val = getattr(cfg, field, None)
        origin = getattr(hint, "__origin__", None)
        # Unwrap Optional
        if origin is Union:
            args = hint.__args__
            non_none = [a for a in args if a is not type(None)]
            if val is not None and non_none:
                hint = non_none[0]
            else:
                continue
        if val is None:
            continue
        # Check basic types
        base = getattr(hint, "__origin__", hint)
        if base in (list, List) and not isinstance(val, list):
            violations.append(f"{field}: expected list, got {type(val).__name__}")
        elif base in (dict, Dict) and not isinstance(val, dict):
            violations.append(f"{field}: expected dict, got {type(val).__name__}")
        elif base is str and not isinstance(val, str):
            violations.append(f"{field}: expected str, got {type(val).__name__}")
        elif base is int and not isinstance(val, (int, bool)):
            violations.append(f"{field}: expected int, got {type(val).__name__}")
        elif base is float and not isinstance(val, (int, float)):
            violations.append(f"{field}: expected float, got {type(val).__name__}")
        elif base is bool and not isinstance(val, bool):
            violations.append(f"{field}: expected bool, got {type(val).__name__}")
    return violations


# ── Security: schema field constraints ───────────────────────────────────

FIELD_CONSTRAINTS: Dict[str, Dict[str, Any]] = {
    # DatabaseConfig
    "pool_size":          {"min": 1,      "max": 100},
    "timeout":            {"min": 0.1,    "max": 300.0},
    "cache_size":         {"min": -500000,"max": 0},
    "backup_interval":    {"min": 60,     "max": 86400},
    "max_backups":        {"min": 0,      "max": 100},
    # SecurityConfig
    "max_input_length":   {"min": 100,    "max": 10_000_000},
    "max_memory_mb":      {"min": 64,     "max": 65536},
    "max_execution_time": {"min": 0.1,    "max": 600.0},
    "rate_limit_per_ip":  {"min": 1,      "max": 100_000},
    "rate_limit_window":  {"min": 1,      "max": 3600},
    # MemoryConfig
    "total_size":         {"min": 1048576,"max": 68719476736},
    "page_size":          {"min": 512,    "max": 65536},
    "gc_interval":        {"min": 1,      "max": 86400},
    # PrecisionConfig
    "decimal_places":     {"min": 1,      "max": 10000},
    "max_precision":      {"min": 1,      "max": 10000},
    # GodModeConfig
    "timeout":            {"min": 0.1,    "max": 600.0},
    "max_iterations":     {"min": 1,      "max": 10_000_000},
    "heuristic_depth":    {"min": 1,      "max": 100_000},
    "max_theorems":       {"min": 1,      "max": 1_000_000},
    # APIConfig
    "port":               {"min": 1,      "max": 65535},
    "workers":            {"min": 1,      "max": 256},
    "max_request_size_mb":{"min": 1,      "max": 1024},
    "jwt_expiry_hours":   {"min": 1,      "max": 8760},
    # LoggingConfig
    "max_size_mb":        {"min": 1,      "max": 10240},
    "backup_count":       {"min": 0,      "max": 100},
}


def enforce_constraints(cfg) -> List[str]:
    """
    Check all numeric fields against FIELD_CONSTRAINTS.
    Returns list of violation strings.
    """
    violations = []
    if not hasattr(cfg, "__dataclass_fields__"):
        return violations
    for field in cfg.__dataclass_fields__:
        val = getattr(cfg, field, None)
        if field not in FIELD_CONSTRAINTS or val is None:
            continue
        if not isinstance(val, (int, float)):
            continue
        bounds = FIELD_CONSTRAINTS[field]
        if "min" in bounds and val < bounds["min"]:
            violations.append(
                f"{type(cfg).__name__}.{field}={val} below min {bounds['min']}")
        if "max" in bounds and val > bounds["max"]:
            violations.append(
                f"{type(cfg).__name__}.{field}={val} above max {bounds['max']}")
    return violations


# ── Standards: environment variable naming convention ─────────────────────

def field_to_env_key(section: str, field: str) -> str:
    """
    Follow the MATH_ENGINE_SECTION__FIELD naming convention.
    Example: database.pool_size → MATH_ENGINE_DATABASE__POOL_SIZE
    """
    return f"MATH_ENGINE_{section.upper()}__{field.upper()}"


def env_key_to_field(env_key: str) -> Optional[Tuple[str, str]]:
    """
    Reverse MATH_ENGINE_SECTION__FIELD → (section, field).
    Returns None if key does not match convention.
    """
    import re
    m = re.match(r"^MATH_ENGINE_([A-Z_]+)__([A-Z_]+)$", env_key)
    if not m:
        return None
    return m.group(1).lower(), m.group(2).lower()


def all_env_keys() -> List[str]:
    """Return every expected environment variable key for all config sections."""
    from dataclasses import fields as dc_fields
    mapping = {
        "database":      DatabaseConfig,
        "security":      SecurityConfig,
        "memory":        MemoryConfig,
        "precision":     PrecisionConfig,
        "god_mode":      GodModeConfig,
        "analytics":     AnalyticsConfig,
        "prediction":    PredictionConfig,
        "randomization": RandomizationConfig,
        "logging":       LoggingConfig,
        "api":           APIConfig,
        "admin":         AdminConfig,
    }
    keys = []
    for section, cls in mapping.items():
        for f in dc_fields(cls):
            keys.append(field_to_env_key(section, f.name))
    return sorted(keys)
