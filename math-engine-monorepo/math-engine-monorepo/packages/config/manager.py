"""
ConfigurationManager — singleton that merges YAML files, env vars, and CLI args.
Priority (highest → lowest): CLI → ENV → config files → defaults
"""

import argparse
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, List, Optional

import yaml

from .schemas import (
    AdminConfig, AnalyticsConfig, APIConfig, DatabaseConfig,
    GodModeConfig, LoggingConfig, MemoryConfig, PrecisionConfig,
    PredictionConfig, RandomizationConfig, SecurityConfig,
)

try:
    import psutil
    _PSUTIL = True
except ImportError:
    _PSUTIL = False


class ConfigurationManager:
    """Singleton configuration manager."""

    _instance: Optional["ConfigurationManager"] = None

    def __new__(cls) -> "ConfigurationManager":
        if cls._instance is None:
            obj = super().__new__(cls)
            obj._initialized = False
            cls._instance = obj
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._watchers: List[Callable] = []
        self._config_file: Optional[str] = None
        self.configs: dict = {}
        self._load_defaults()
        self._load_from_files()
        self._load_from_env()
        self._load_from_cli()
        self._validate()

    # ------------------------------------------------------------------ #
    #  Loading layers                                                       #
    # ------------------------------------------------------------------ #

    def _load_defaults(self) -> None:
        self.configs = {
            "database":      DatabaseConfig(),
            "security":      SecurityConfig(),
            "memory":        MemoryConfig(),
            "precision":     PrecisionConfig(),
            "god_mode":      GodModeConfig(),
            "analytics":     AnalyticsConfig(),
            "prediction":    PredictionConfig(),
            "randomization": RandomizationConfig(),
            "logging":       LoggingConfig(),
            "api":           APIConfig(),
            "admin":         AdminConfig(),
        }

    def _load_from_files(self) -> None:
        search_paths = [
            "config.yaml", "config.yml", "config.json",
            "/etc/math_engine/config.yaml",
            str(Path.home() / ".math_engine" / "config.yaml"),
            "config/config.yaml",
        ]
        for path in search_paths:
            expanded = Path(path).expanduser()
            if expanded.exists():
                try:
                    with open(expanded) as f:
                        data = yaml.safe_load(f) if expanded.suffix in (".yaml", ".yml") else json.load(f)
                    self._merge(data)
                    self._config_file = str(expanded)
                    print(f"[CONFIG] Loaded from {expanded}")
                except Exception as exc:
                    print(f"[CONFIG] Error loading {expanded}: {exc}")

    def _load_from_env(self) -> None:
        prefix = "MATH_ENGINE_"
        for key, raw in os.environ.items():
            if not key.startswith(prefix):
                continue
            parts = key[len(prefix):].lower().split("__")
            target = self.configs
            for part in parts[:-1]:
                if part not in target:
                    target[part] = {}
                target = target[part]
            target[parts[-1]] = self._coerce(raw)

    def _load_from_cli(self) -> None:
        p = argparse.ArgumentParser(add_help=False)
        p.add_argument("--config")
        p.add_argument("--host")
        p.add_argument("--port", type=int)
        p.add_argument("--admin-port", type=int)
        p.add_argument("--log-level")
        p.add_argument("--db-path")
        p.add_argument("--memory-size", type=int)
        p.add_argument("--precision", type=int)
        p.add_argument("--god-mode", action="store_true", default=None)
        p.add_argument("--no-god-mode", action="store_true", default=None)
        args, _ = p.parse_known_args()

        if args.config:         self._load_specific(args.config)
        if args.host:           self.set("api.host", args.host)
        if args.port:           self.set("api.port", args.port)
        if args.admin_port:     self.set("admin.port", args.admin_port)
        if args.log_level:      self.set("logging.level", args.log_level)
        if args.db_path:        self.set("database.path", args.db_path)
        if args.memory_size:    self.set("memory.total_size", args.memory_size)
        if args.precision:      self.set("precision.decimal_places", args.precision)
        if args.god_mode:       self.set("god_mode.enabled", True)
        if args.no_god_mode:    self.set("god_mode.enabled", False)

    def _load_specific(self, path: str) -> None:
        expanded = Path(path).expanduser()
        if not expanded.exists():
            return
        try:
            with open(expanded) as f:
                data = yaml.safe_load(f) if expanded.suffix in (".yaml", ".yml") else json.load(f)
            self._merge(data)
            self._config_file = str(expanded)
        except Exception as exc:
            print(f"[CONFIG] Error loading {expanded}: {exc}")

    # ------------------------------------------------------------------ #
    #  Merging helpers                                                      #
    # ------------------------------------------------------------------ #

    def _merge(self, data: dict, target: Optional[dict] = None) -> None:
        if target is None:
            target = self.configs
        for key, value in data.items():
            if key in target and isinstance(target[key], dict) and isinstance(value, dict):
                self._merge(value, target[key])
            elif key in target and hasattr(target[key], "__dataclass_fields__"):
                if isinstance(value, dict):
                    for subkey, subval in value.items():
                        if hasattr(target[key], subkey):
                            setattr(target[key], subkey, subval)
            else:
                target[key] = value

    @staticmethod
    def _coerce(value: str) -> Any:
        """Coerce env-var strings to Python primitives."""
        if value.lower() == "true":   return True
        if value.lower() == "false":  return False
        if value.isdigit():           return int(value)
        try:                          return float(value)
        except ValueError:            pass
        if value.startswith("["):     return json.loads(value)
        if value.startswith("{"):     return json.loads(value)
        return value

    # ------------------------------------------------------------------ #
    #  Validation                                                           #
    # ------------------------------------------------------------------ #

    def _validate(self) -> None:
        db_path = Path(self.get("database.path"))
        db_path.parent.mkdir(parents=True, exist_ok=True)

        if _PSUTIL:
            total_ram = psutil.virtual_memory().total
            if self.get("memory.total_size") > total_ram:
                self.set("memory.total_size", total_ram)

        api_port = self.get("api.port")
        admin_port = self.get("admin.port")
        if api_port == admin_port:
            self.set("admin.port", api_port + 1)

    # ------------------------------------------------------------------ #
    #  Public API                                                           #
    # ------------------------------------------------------------------ #

    def get(self, path: str, default: Any = None) -> Any:
        keys = path.split(".")
        node = self.configs
        for key in keys:
            if isinstance(node, dict):
                node = node.get(key)
            elif hasattr(node, key):
                node = getattr(node, key)
            else:
                return default
            if node is None:
                return default
        return node

    def set(self, path: str, value: Any) -> None:
        keys = path.split(".")
        target = self.configs
        for key in keys[:-1]:
            if key not in target:
                target[key] = {}
            target = target[key]
        if hasattr(target, keys[-1]):
            setattr(target, keys[-1], value)
        else:
            target[keys[-1]] = value
        for watcher in self._watchers:
            try: watcher(path, value)
            except Exception: pass

    def watch(self, callback: Callable) -> None:
        self._watchers.append(callback)

    def save(self, path: Optional[str] = None) -> None:
        save_path = path or self._config_file or "config.yaml"

        def _to_dict(obj: Any) -> Any:
            if hasattr(obj, "__dataclass_fields__"): return {k: _to_dict(v) for k, v in asdict(obj).items()}
            if isinstance(obj, dict):                return {k: _to_dict(v) for k, v in obj.items()}
            if isinstance(obj, list):                return [_to_dict(v) for v in obj]
            return obj

        with open(save_path, "w") as f:
            if str(save_path).endswith((".yaml", ".yml")):
                yaml.dump(_to_dict(self.configs), f, default_flow_style=False)
            else:
                json.dump(_to_dict(self.configs), f, indent=2)
        print(f"[CONFIG] Saved to {save_path}")

    def reload(self) -> None:
        if self._config_file:
            self._load_specific(self._config_file)

    def get_all(self) -> dict:
        return self.configs

    # ── Extended business logic ────────────────────────────────────────────

    def get_section(self, section: str) -> Any:
        """Return an entire config section as a dataclass or dict."""
        return self.configs.get(section)

    def diff(self, other: "ConfigurationManager") -> dict:
        """Return keys that differ between two ConfigurationManager instances."""
        diffs = {}
        for key in self.configs:
            v1 = self.get(key)
            v2 = other.get(key)
            if v1 != v2:
                diffs[key] = {"current": v1, "other": v2}
        return diffs

    def export_env(self) -> str:
        """Export all settings as MATH_ENGINE_* environment variable lines."""
        lines = []
        def _walk(obj, prefix):
            if hasattr(obj, "__dataclass_fields__"):
                for k in obj.__dataclass_fields__:
                    _walk(getattr(obj, k), f"{prefix}__{k.upper()}")
            elif isinstance(obj, dict):
                for k, v in obj.items():
                    _walk(v, f"{prefix}__{k.upper()}")
            else:
                lines.append(f"MATH_ENGINE_{prefix}={obj}")
        for section, val in self.configs.items():
            _walk(val, section.upper())
        return "\n".join(sorted(lines))

    def apply_profile(self, profile: str) -> None:
        """Apply a named configuration profile: dev, staging, production."""
        profiles = {
            "dev": {
                "logging.level":         "DEBUG",
                "security.sandbox_enabled": False,
                "api.cors_origins":      ["*"],
                "god_mode.enabled":      True,
                "database.backup_interval": 7200,
            },
            "staging": {
                "logging.level":         "INFO",
                "security.sandbox_enabled": True,
                "api.ssl_enabled":       False,
                "god_mode.timeout":      30.0,
            },
            "production": {
                "logging.level":         "WARNING",
                "security.sandbox_enabled": True,
                "security.api_key_required": True,
                "api.ssl_enabled":       True,
                "admin.require_auth":    True,
                "database.backup_interval": 1800,
                "god_mode.timeout":      15.0,
            },
        }
        settings = profiles.get(profile.lower())
        if settings is None:
            raise ValueError(f"Unknown profile '{profile}'. Choose: {list(profiles)}")
        for key, value in settings.items():
            self.set(key, value)
        print(f"[CONFIG] Applied profile: {profile}")

    def validate_runtime(self) -> list:
        """Validate current configuration at runtime. Returns list of warnings."""
        warnings = []
        if self.get("api.port") == self.get("admin.port"):
            warnings.append("api.port and admin.port are the same")
        if self.get("security.max_execution_time", 60) > 300:
            warnings.append("max_execution_time > 300s may cause hangs")
        if self.get("memory.total_size", 0) < 10 * 1024 * 1024:
            warnings.append("memory.total_size < 10 MB is very low")
        if self.get("precision.decimal_places", 100) > 500:
            warnings.append("decimal_places > 500 will be very slow")
        if self.get("prediction.ensemble_models") and \
           len(self.get("prediction.ensemble_models")) == 0:
            warnings.append("prediction.ensemble_models is empty")
        return warnings

    def to_dict(self) -> dict:
        from dataclasses import asdict
        result = {}
        for k, v in self.configs.items():
            result[k] = asdict(v) if hasattr(v, "__dataclass_fields__") else v
        return result

    def reset_to_defaults(self, section: str = None) -> None:
        """Reset one section or all to defaults."""
        from .schemas import (DatabaseConfig, SecurityConfig, MemoryConfig,
                               PrecisionConfig, GodModeConfig, AnalyticsConfig,
                               PredictionConfig, RandomizationConfig,
                               LoggingConfig, APIConfig, AdminConfig)
        defaults = {
            "database": DatabaseConfig, "security": SecurityConfig,
            "memory": MemoryConfig, "precision": PrecisionConfig,
            "god_mode": GodModeConfig, "analytics": AnalyticsConfig,
            "prediction": PredictionConfig, "randomization": RandomizationConfig,
            "logging": LoggingConfig, "api": APIConfig, "admin": AdminConfig,
        }
        if section:
            if section not in defaults:
                raise ValueError(f"Unknown section '{section}'")
            self.configs[section] = defaults[section]()
        else:
            for k, cls in defaults.items():
                self.configs[k] = cls()
        print(f"[CONFIG] Reset {'section '+section if section else 'all sections'} to defaults")


# ── Security: configuration validation ───────────────────────────────────

class ConfigSecurityValidator:
    """
    Validates configuration for security-sensitive values.
    Prevents misconfiguration from opening attack surfaces.
    """

    WEAK_PASSWORDS = {"admin", "password", "123456", "admin123", "letmein", ""}

    @classmethod
    def validate_admin_password(cls, pw_hash: str) -> list:
        issues = []
        if not pw_hash:
            issues.append("admin.password_hash is empty — authentication disabled")
        return issues

    @classmethod
    def validate_jwt_secret(cls, secret) -> list:
        issues = []
        if secret is None:
            issues.append("api.jwt_secret not set — JWT auth disabled")
        elif len(str(secret)) < 32:
            issues.append("api.jwt_secret is too short (< 32 chars)")
        return issues

    @classmethod
    def validate_ssl_config(cls, cert_path, key_path, ssl_enabled) -> list:
        import os
        issues = []
        if ssl_enabled:
            if not cert_path or not os.path.exists(str(cert_path)):
                issues.append("ssl_enabled=True but ssl_cert_path is missing")
            if not key_path or not os.path.exists(str(key_path)):
                issues.append("ssl_enabled=True but ssl_key_path is missing")
        return issues

    @classmethod
    def validate_cors(cls, origins: list) -> list:
        issues = []
        if origins == ["*"]:
            issues.append("CORS allows all origins — restrict in production")
        return issues

    @classmethod
    def validate_rate_limits(cls, limit: int, window: int) -> list:
        issues = []
        if limit > 10_000:
            issues.append(f"rate_limit_per_ip={limit} is very high")
        if window < 10:
            issues.append("rate_limit_window < 10s may be too restrictive")
        return issues

    @classmethod
    def full_audit(cls, config: "ConfigurationManager") -> dict:
        """Run all security checks and return a full audit report."""
        issues = []
        issues += cls.validate_admin_password(config.get("admin.password_hash",""))
        issues += cls.validate_jwt_secret(config.get("api.jwt_secret"))
        issues += cls.validate_ssl_config(
            config.get("security.ssl_cert_path"),
            config.get("security.ssl_key_path"),
            config.get("api.ssl_enabled", False))
        issues += cls.validate_cors(config.get("api.cors_origins",["*"]))
        issues += cls.validate_rate_limits(
            config.get("security.rate_limit_per_ip", 100),
            config.get("security.rate_limit_window", 60))
        return {
            "issues":       issues,
            "issue_count":  len(issues),
            "severity":     "critical" if any("missing" in i or "empty" in i
                                              for i in issues) else "warning",
            "pass":         len(issues) == 0,
        }


# ── Standards: configuration documentation ───────────────────────────────

CONFIG_SCHEMA_DOC = {
    "database.path":               {"type": "str",   "default": "math_engine.db",   "description": "SQLite file path"},
    "database.backup_interval":    {"type": "int",   "default": 3600,               "description": "Backup interval in seconds"},
    "database.max_backups":        {"type": "int",   "default": 5,                  "description": "Number of compressed backups to retain"},
    "security.max_execution_time": {"type": "float", "default": 60.0,               "description": "Max seconds for any single evaluation"},
    "security.sandbox_enabled":    {"type": "bool",  "default": True,               "description": "Enable eval sandbox restrictions"},
    "memory.total_size":           {"type": "int",   "default": 104857600,          "description": "Virtual memory pool size in bytes"},
    "precision.decimal_places":    {"type": "int",   "default": 100,                "description": "Decimal precision digits"},
    "god_mode.enabled":            {"type": "bool",  "default": True,               "description": "Enable heuristic theorem prover"},
    "api.host":                    {"type": "str",   "default": "127.0.0.1",        "description": "API bind address"},
    "api.port":                    {"type": "int",   "default": 8080,               "description": "API port"},
    "api.ssl_enabled":             {"type": "bool",  "default": False,              "description": "Enable HTTPS"},
    "admin.port":                  {"type": "int",   "default": 8081,               "description": "Admin panel port"},
    "admin.require_auth":          {"type": "bool",  "default": True,               "description": "Require admin login"},
    "logging.level":               {"type": "str",   "default": "INFO",             "description": "Log level: DEBUG/INFO/WARNING/ERROR"},
    "prediction.ensemble_models":  {"type": "list",  "default": ["rf","gb","gp","mlp","lr"], "description": "Models in prediction ensemble"},
}

def print_config_help() -> None:
    """Print a human-readable config reference."""
    print(f"{'Key':<45} {'Type':<8} {'Default':<25} Description")
    print("-" * 110)
    for key, info in sorted(CONFIG_SCHEMA_DOC.items()):
        print(f"{key:<45} {info['type']:<8} {str(info['default']):<25} {info['description']}")
