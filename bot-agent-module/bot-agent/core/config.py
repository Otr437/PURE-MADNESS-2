"""
Configuration Loader — May 30, 2026
.env, environment variables, YAML/JSON config files, validation.
Single source of truth for all module settings.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("config")


def _env(key: str, default: Any = "", cast=str) -> Any:
    val = os.environ.get(key, "")
    if val == "":
        return default
    try:
        if cast == bool:
            return val.lower() in ("1", "true", "yes", "on")
        return cast(val)
    except Exception:
        return default


def load_dotenv(path: str = ".env"):
    """Load .env file without requiring python-dotenv."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    logger.debug(f"[CONFIG] Loaded .env from {path}")


@dataclass
class APIKeys:
    anthropic:   str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    openai:      str = field(default_factory=lambda: _env("OPENAI_API_KEY"))
    google:      str = field(default_factory=lambda: _env("GOOGLE_API_KEY"))
    serper:      str = field(default_factory=lambda: _env("SERPER_API_KEY"))
    brave:       str = field(default_factory=lambda: _env("BRAVE_SEARCH_API_KEY"))
    browserbase: str = field(default_factory=lambda: _env("BROWSERBASE_API_KEY"))
    steel:       str = field(default_factory=lambda: _env("STEEL_API_KEY"))

    def available_models(self) -> list[str]:
        models = []
        if self.anthropic:
            models += ["claude", "fast", "opus"]
        if self.openai:
            models += ["openai", "openai-mini"]
        if self.google:
            models += ["gemini", "gemini-flash"]
        return models or ["mock"]

    def validate(self) -> dict[str, bool]:
        return {
            "anthropic":   bool(self.anthropic),
            "openai":      bool(self.openai),
            "google":      bool(self.google),
            "serper":      bool(self.serper),
            "brave":       bool(self.brave),
            "browserbase": bool(self.browserbase),
            "steel":       bool(self.steel),
        }


@dataclass
class AgentConfig:
    # LLM
    default_model:       str   = field(default_factory=lambda: _env("AGENT_MODEL", "claude"))
    fast_model:          str   = field(default_factory=lambda: _env("AGENT_FAST_MODEL", "fast"))
    # Limits
    session_token_limit: int   = field(default_factory=lambda: _env("AGENT_TOKEN_LIMIT", 200_000, int))
    iteration_limit:     int   = field(default_factory=lambda: _env("AGENT_ITER_LIMIT", 25, int))
    per_step_tokens:     int   = field(default_factory=lambda: _env("AGENT_STEP_TOKENS", 8_000, int))
    # Budget
    per_session_usd:     float = field(default_factory=lambda: _env("AGENT_SESSION_USD", 2.0, float))
    daily_usd:           float = field(default_factory=lambda: _env("AGENT_DAILY_USD", 20.0, float))
    monthly_usd:         float = field(default_factory=lambda: _env("AGENT_MONTHLY_USD", 100.0, float))
    # Memory
    memory_dir:          str   = field(default_factory=lambda: _env("AGENT_MEMORY_DIR", "./agent_memory"))
    session_dir:         str   = field(default_factory=lambda: _env("AGENT_SESSION_DIR", "./sessions"))
    # Logging
    log_level:           str   = field(default_factory=lambda: _env("LOG_LEVEL", "INFO"))
    log_file:            str   = field(default_factory=lambda: _env("LOG_FILE", ""))
    structured_logs:     bool  = field(default_factory=lambda: _env("LOG_STRUCTURED", False, bool))
    # Health server
    health_port:         int   = field(default_factory=lambda: _env("HEALTH_PORT", 8765, int))
    health_enabled:      bool  = field(default_factory=lambda: _env("HEALTH_ENABLED", True, bool))
    # Session persistence
    save_sessions:       bool  = field(default_factory=lambda: _env("SAVE_SESSIONS", False, bool))
    persist_budget_log:  bool  = field(default_factory=lambda: _env("PERSIST_BUDGET_LOG", False, bool))


@dataclass
class BrowserCfg:
    mode:          str   = field(default_factory=lambda: _env("BROWSER_MODE", "headless"))
    headless:      bool  = field(default_factory=lambda: _env("BROWSER_HEADLESS", True, bool))
    cdp_url:       str   = field(default_factory=lambda: _env("BROWSER_CDP_URL", "http://localhost:9222"))
    executable:    str   = field(default_factory=lambda: _env("BROWSER_EXECUTABLE", ""))
    stealth:       bool  = field(default_factory=lambda: _env("BROWSER_STEALTH", True, bool))
    slow_mo:       int   = field(default_factory=lambda: _env("BROWSER_SLOW_MO", 0, int))
    downloads_dir: str   = field(default_factory=lambda: _env("BROWSER_DOWNLOADS", "./downloads"))
    proxy:         str   = field(default_factory=lambda: _env("BROWSER_PROXY", ""))
    record_video:  bool  = field(default_factory=lambda: _env("BROWSER_RECORD_VIDEO", False, bool))
    block_images:  bool  = field(default_factory=lambda: _env("BROWSER_BLOCK_IMAGES", False, bool))


@dataclass
class AppConfig:
    keys:    APIKeys   = field(default_factory=APIKeys)
    agent:   AgentConfig = field(default_factory=AgentConfig)
    browser: BrowserCfg  = field(default_factory=BrowserCfg)

    @classmethod
    def load(cls, env_file: str = ".env", config_file: str = "") -> "AppConfig":
        """Load from .env then optional JSON/YAML config file."""
        load_dotenv(env_file)
        cfg = cls()
        if config_file and os.path.exists(config_file):
            cfg._apply_file(config_file)
        logger.info(f"[CONFIG] Loaded | models={cfg.keys.available_models()} | "
                    f"token_limit={cfg.agent.session_token_limit:,} | "
                    f"browser_mode={cfg.browser.mode}")
        return cfg

    def _apply_file(self, path: str):
        """Override config from JSON file."""
        try:
            with open(path) as f:
                data = json.load(f)
            for section, values in data.items():
                target = getattr(self, section, None)
                if target and isinstance(values, dict):
                    for k, v in values.items():
                        if hasattr(target, k):
                            setattr(target, k, v)
            logger.info(f"[CONFIG] Applied overrides from {path}")
        except Exception as e:
            logger.warning(f"[CONFIG] File load error ({path}): {e}")

    def to_dict(self) -> dict:
        def mask(v: str) -> str:
            return v[:4] + "****" if v and len(v) > 4 else ("set" if v else "NOT SET")
        return {
            "api_keys": {k: mask(v) for k, v in self.keys.validate().items()
                         if isinstance(v, bool)},
            "keys_status": self.keys.validate(),
            "available_models": self.keys.available_models(),
            "agent": {
                "model":         self.agent.default_model,
                "token_limit":   self.agent.session_token_limit,
                "iter_limit":    self.agent.iteration_limit,
                "session_usd":   self.agent.per_session_usd,
                "daily_usd":     self.agent.daily_usd,
                "monthly_usd":   self.agent.monthly_usd,
                "save_sessions": self.agent.save_sessions,
            },
            "browser": {
                "mode":      self.browser.mode,
                "headless":  self.browser.headless,
                "stealth":   self.browser.stealth,
                "proxy_set": bool(self.browser.proxy),
            },
        }

    def print_status(self):
        import json
        print("\n" + "═" * 55)
        print("  BOT AGENT CONFIG STATUS")
        print("═" * 55)
        d = self.to_dict()
        print(f"  API Keys:     {d['keys_status']}")
        print(f"  Models:       {d['available_models']}")
        print(f"  Token limit:  {d['agent']['token_limit']:,}")
        print(f"  Budget/sess:  ${d['agent']['session_usd']}")
        print(f"  Budget/day:   ${d['agent']['daily_usd']}")
        print(f"  Browser mode: {d['browser']['mode']} | headless={d['browser']['headless']}")
        print("═" * 55 + "\n")


# Global singleton
_config: Optional[AppConfig] = None

def get_config(env_file: str = ".env", config_file: str = "") -> AppConfig:
    global _config
    if _config is None:
        _config = AppConfig.load(env_file, config_file)
    return _config
