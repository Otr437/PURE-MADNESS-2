// src/config-validator.ts
// Validates all environment variables and config at startup.
// Fails fast with clear errors before any code runs.
// No scattered process.env reads anywhere else in the codebase.

import { existsSync } from "fs";

export interface ConfigError {
  field: string;
  message: string;
  fatal: boolean;
}

export interface ValidatedConfig {
  anthropicApiKey: string;
  openaiApiKey: string | null;
  groqApiKey: string | null;
  deepseekApiKey: string | null;
  braveApiKey: string | null;
  serperApiKey: string | null;
  tavilyApiKey: string | null;
  evmRpcUrl: string;
  zcashRpcUrl: string | null;
  zcashRpcUser: string | null;
  zcashRpcPass: string | null;
  maxTxEth: number;
  maxTxBtc: number;
  maxTxZec: number;
  maxSessionEth: number;
  maxSessionBtc: number;
  maxSessionZec: number;
  maxTxCount: number;
  browserChannel: "chromium" | "chrome" | "msedge";
  vaultDir: string;
  logDir: string;
}

export class ConfigValidator {
  private errors: ConfigError[] = [];
  private warnings: ConfigError[] = [];

  private requireEnv(key: string): string | null {
    const val = process.env[key];
    if (!val || val.trim() === "") {
      this.errors.push({ field: key, message: `Required env var ${key} is missing`, fatal: true });
      return null;
    }
    return val.trim();
  }

  private optionalEnv(key: string): string | null {
    const val = process.env[key];
    return val?.trim() || null;
  }

  private requirePositiveFloat(key: string, defaultVal: number): number {
    const raw = this.optionalEnv(key);
    if (!raw) return defaultVal;
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) {
      this.errors.push({ field: key, message: `${key} must be a positive number, got: ${raw}`, fatal: true });
      return defaultVal;
    }
    return n;
  }

  private requirePositiveInt(key: string, defaultVal: number): number {
    const raw = this.optionalEnv(key);
    if (!raw) return defaultVal;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      this.errors.push({ field: key, message: `${key} must be a positive integer, got: ${raw}`, fatal: true });
      return defaultVal;
    }
    return n;
  }

  private validateUrl(key: string, val: string | null): boolean {
    if (!val) return false;
    try {
      const u = new URL(val);
      if (!["http:", "https:"].includes(u.protocol)) {
        this.errors.push({ field: key, message: `${key} must use http/https`, fatal: false });
        return false;
      }
      return true;
    } catch {
      this.errors.push({ field: key, message: `${key} is not a valid URL`, fatal: false });
      return false;
    }
  }

  private validateChannel(raw: string | null): "chromium" | "chrome" | "msedge" {
    const allowed = ["chromium", "chrome", "msedge"] as const;
    if (!raw) return "chromium";
    if (!allowed.includes(raw as any)) {
      this.warnings.push({ field: "BROWSER_CHANNEL", message: `Unknown browser channel "${raw}", using chromium`, fatal: false });
      return "chromium";
    }
    return raw as "chromium" | "chrome" | "msedge";
  }

  validate(): ValidatedConfig {
    const anthropicApiKey = this.requireEnv("ANTHROPIC_API_KEY") ?? "";
    if (anthropicApiKey && !anthropicApiKey.startsWith("sk-ant-")) {
      this.warnings.push({ field: "ANTHROPIC_API_KEY", message: "Key does not match expected sk-ant- prefix", fatal: false });
    }

    const evmRpcUrl = this.optionalEnv("EVM_RPC_URL") ?? "https://eth.llamarpc.com";
    this.validateUrl("EVM_RPC_URL", evmRpcUrl);

    const zcashRpcUrl  = this.optionalEnv("ZCASH_RPC_URL");
    const zcashRpcUser = this.optionalEnv("ZCASH_RPC_USER");
    const zcashRpcPass = this.optionalEnv("ZCASH_RPC_PASS");

    if (zcashRpcUrl && (!zcashRpcUser || !zcashRpcPass)) {
      this.warnings.push({ field: "ZCASH_RPC", message: "ZCASH_RPC_URL set but USER or PASS missing", fatal: false });
    }
    if (zcashRpcUrl) {
      this.validateUrl("ZCASH_RPC_URL", zcashRpcUrl);
    }

    // Search API — at least one must be set for web_search tool to work
    const braveApiKey   = this.optionalEnv("BRAVE_API_KEY");
    const serperApiKey  = this.optionalEnv("SERPER_API_KEY");
    const tavilyApiKey  = this.optionalEnv("TAVILY_API_KEY");
    if (!braveApiKey && !serperApiKey && !tavilyApiKey) {
      this.warnings.push({ field: "SEARCH_API_KEY", message: "No search API key set (BRAVE_API_KEY / SERPER_API_KEY / TAVILY_API_KEY). web_search tool will throw at runtime.", fatal: false });
    }

    const vaultDir = this.optionalEnv("VAULT_DIR") ?? ".vault";
    const logDir   = this.optionalEnv("LOG_DIR")   ?? "traces";

    return {
      anthropicApiKey,
      openaiApiKey:   this.optionalEnv("OPENAI_API_KEY"),
      groqApiKey:     this.optionalEnv("GROQ_API_KEY"),
      deepseekApiKey: this.optionalEnv("DEEPSEEK_API_KEY"),
      braveApiKey,
      serperApiKey,
      tavilyApiKey,
      evmRpcUrl,
      zcashRpcUrl,
      zcashRpcUser,
      zcashRpcPass,
      maxTxEth:      this.requirePositiveFloat("MAX_TX_ETH",    0.05),
      maxTxBtc:      this.requirePositiveFloat("MAX_TX_BTC",    0.001),
      maxTxZec:      this.requirePositiveFloat("MAX_TX_ZEC",    0.1),
      maxSessionEth: this.requirePositiveFloat("MAX_SES_ETH",   0.1),
      maxSessionBtc: this.requirePositiveFloat("MAX_SES_BTC",   0.002),
      maxSessionZec: this.requirePositiveFloat("MAX_SES_ZEC",   0.2),
      maxTxCount:    this.requirePositiveInt("MAX_TX_COUNT",    3),
      browserChannel: this.validateChannel(this.optionalEnv("BROWSER_CHANNEL")),
      vaultDir,
      logDir,
    };
  }

  printAndExit(): ValidatedConfig {
    const config = this.validate();
    let hasFatal = false;

    if (this.errors.length > 0) {
      console.error("\n[config] ✗ Configuration errors:");
      for (const e of this.errors) {
        console.error(`  ${e.fatal ? "FATAL" : "ERROR"}: [${e.field}] ${e.message}`);
        if (e.fatal) hasFatal = true;
      }
    }

    if (this.warnings.length > 0) {
      console.warn("\n[config] ⚠ Configuration warnings:");
      for (const w of this.warnings) {
        console.warn(`  WARN: [${w.field}] ${w.message}`);
      }
    }

    if (hasFatal) {
      console.error("\n[config] Fatal errors — cannot start. Fix .env and retry.\n");
      process.exit(1);
    }

    console.log("[config] ✓ Configuration valid\n");
    return config;
  }
}
