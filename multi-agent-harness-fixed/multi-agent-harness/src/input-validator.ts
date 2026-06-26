// src/input-validator.ts
// Centralized input validation for every method, endpoint, and tool.
// All validation lives here — never scattered inline across files.
// Every public method that accepts external data must call through this.

import { createHash } from "crypto";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized: Record<string, unknown>;
}

export class InputValidator {

  // ── Primitive guards ────────────────────────────────────────────────────────

  static isNonEmptyString(val: unknown, field: string): string | null {
    if (typeof val !== "string" || val.trim().length === 0) {
      return `${field} must be a non-empty string`;
    }
    return null;
  }

  static isHex64(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^[0-9a-fA-F]{64}$/.test(val)) {
      return `${field} must be a 64-char hex string`;
    }
    return null;
  }

  static isHex40(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^[0-9a-fA-F]{40}$/.test(val)) {
      return `${field} must be a 40-char hex string`;
    }
    return null;
  }

  static isSafeFilename(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^[\w\-]{1,64}$/.test(val)) {
      return `${field} must be alphanumeric/dash/underscore, max 64 chars`;
    }
    return null;
  }

  static isPositiveNumber(val: unknown, field: string): string | null {
    if (typeof val !== "number" || !isFinite(val) || val <= 0) {
      return `${field} must be a positive finite number`;
    }
    return null;
  }

  static isNonNegativeInteger(val: unknown, field: string): string | null {
    if (!Number.isInteger(val) || (val as number) < 0) {
      return `${field} must be a non-negative integer`;
    }
    return null;
  }

  static isBigIntPositive(val: unknown, field: string): string | null {
    if (typeof val !== "bigint" || val <= 0n) {
      return `${field} must be a positive bigint`;
    }
    return null;
  }

  static isEnum<T extends string>(val: unknown, field: string, allowed: T[]): string | null {
    if (!allowed.includes(val as T)) {
      return `${field} must be one of: ${allowed.join(", ")}`;
    }
    return null;
  }

  static isBoolean(val: unknown, field: string): string | null {
    if (typeof val !== "boolean") return `${field} must be a boolean`;
    return null;
  }

  // ── URL validation ──────────────────────────────────────────────────────────

  static isHttpUrl(val: unknown, field: string): string | null {
    if (typeof val !== "string") return `${field} must be a string`;
    try {
      const u = new URL(val);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return `${field} must use http: or https: scheme`;
      }
    } catch {
      return `${field} is not a valid URL`;
    }
    return null;
  }

  static isHttpsOnly(val: unknown, field: string): string | null {
    if (typeof val !== "string") return `${field} must be a string`;
    try {
      const u = new URL(val);
      if (u.protocol !== "https:") return `${field} must use https: only`;
    } catch {
      return `${field} is not a valid URL`;
    }
    return null;
  }

  // ── Address validation ──────────────────────────────────────────────────────

  static isEvmAddress(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(val)) {
      return `${field} must be a valid EVM address (0x + 40 hex chars)`;
    }
    return null;
  }

  static isBtcAddress(val: unknown, field: string): string | null {
    // Covers legacy (1/3), bech32 (bc1), bech32m (bc1p)
    if (typeof val !== "string" || !/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(val)) {
      return `${field} must be a valid Bitcoin mainnet address`;
    }
    return null;
  }

  static isZecAddress(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^(t1|t3|zs)[a-zA-Z0-9]{33,87}$/.test(val)) {
      return `${field} must be a valid Zcash address`;
    }
    return null;
  }

  static isDerivationPath(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^m(\/\d+'?)+$/.test(val)) {
      return `${field} must be a BIP-44 derivation path (e.g. m/44'/60'/0'/0/0)`;
    }
    return null;
  }

  // ── Amount validation ───────────────────────────────────────────────────────

  static isAmountString(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^\d+(\.\d{1,18})?$/.test(val.trim())) {
      return `${field} must be a decimal amount string (e.g. "0.05")`;
    }
    const n = parseFloat(val);
    if (!isFinite(n) || n <= 0) return `${field} must be a positive number`;
    return null;
  }

  // ── Command / text validation ───────────────────────────────────────────────

  static isSafeCommand(val: unknown, field: string): string | null {
    if (typeof val !== "string") return `${field} must be a string`;
    if (val.length > 2048) return `${field} exceeds 2048 char limit`;
    if (val.trim().length === 0) return `${field} cannot be empty`;
    // Block null bytes and control chars (except newlines/tabs)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(val)) {
      return `${field} contains disallowed control characters`;
    }
    return null;
  }

  static isSafeText(val: unknown, field: string, maxLen = 4096): string | null {
    if (typeof val !== "string") return `${field} must be a string`;
    if (val.length > maxLen) return `${field} exceeds ${maxLen} char limit`;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(val)) {
      return `${field} contains disallowed control characters`;
    }
    return null;
  }

  static isSafeCssSelector(val: unknown, field: string): string | null {
    if (val === undefined || val === null) return null; // optional field
    if (typeof val !== "string") return `${field} must be a string`;
    if (val.length > 256) return `${field} exceeds 256 char selector limit`;
    // Block script injections in selectors
    if (/javascript:|expression\(|url\(/i.test(val)) {
      return `${field} contains disallowed CSS selector content`;
    }
    return null;
  }

  static isSafeJavaScript(val: unknown, field: string): string | null {
    if (typeof val !== "string") return `${field} must be a string`;
    if (val.length > 8192) return `${field} exceeds 8192 char JS limit`;
    // Block attempts to access process / require / eval of arbitrary strings
    if (/process\.env|require\s*\(|import\s*\(|__dirname|__filename/.test(val)) {
      return `${field} contains disallowed Node.js access patterns`;
    }
    return null;
  }

  // ── Vault key name ──────────────────────────────────────────────────────────

  static isVaultKeyName(val: unknown, field: string): string | null {
    if (typeof val !== "string" || !/^[\w\-\.]{1,64}$/.test(val)) {
      return `${field} must be alphanumeric/dash/underscore/dot, max 64 chars`;
    }
    return null;
  }

  // ── Compose multiple checks ─────────────────────────────────────────────────

  static run(checks: Array<string | null>): ValidationResult {
    const errors = checks.filter((e): e is string => e !== null);
    return { valid: errors.length === 0, errors, sanitized: {} };
  }

  // ── Browser tool payloads ───────────────────────────────────────────────────

  static browserNavigate(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isHttpUrl(a?.url, "url"),
    ]);
  }

  static browserClick(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.description, "description", 256),
    ]);
  }

  static browserTypeText(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.field, "field", 256),
      InputValidator.isSafeText(a?.text, "text", 2048),
      InputValidator.isBoolean(a?.press_enter ?? false, "press_enter"),
    ]);
  }

  static browserReadPage(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeCssSelector(a?.selector, "selector"),
    ]);
  }

  static browserScreenshot(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeFilename(
        (a?.filename as string)?.replace(/\.png$/, "") ?? "screenshot",
        "filename"
      ),
    ]);
  }

  static browserScroll(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isEnum(a?.direction, "direction", ["up", "down"]),
      InputValidator.isPositiveNumber(a?.amount ?? 500, "amount"),
    ]);
  }

  static browserRunJs(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeJavaScript(a?.code, "code"),
    ]);
  }

  static browserExtract(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.target, "target", 256),
      InputValidator.isSafeCssSelector(a?.selector, "selector"),
    ]);
  }

  static browserSelectOption(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.field, "field", 256),
      InputValidator.isSafeText(a?.value, "value", 256),
    ]);
  }

  static browserCheckBox(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.label, "label", 256),
      InputValidator.isBoolean(a?.checked ?? true, "checked"),
    ]);
  }

  static browserHover(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.description, "description", 256),
    ]);
  }

  static browserWaitFor(args: unknown): ValidationResult {
    const a = args as Record<string, unknown>;
    return InputValidator.run([
      InputValidator.isSafeText(a?.text, "text", 256),
      InputValidator.isPositiveNumber(a?.timeout_ms ?? 8000, "timeout_ms"),
    ]);
  }

  // ── Wallet payloads ─────────────────────────────────────────────────────────

  static walletRegister(chain: unknown, address: unknown, path: unknown): ValidationResult {
    const c = chain as string;
    const checks: Array<string | null> = [
      InputValidator.isEnum(chain, "chain", ["evm", "btc", "zcash"]),
      InputValidator.isDerivationPath(path, "derivationPath"),
    ];
    if (c === "evm")   checks.push(InputValidator.isEvmAddress(address, "address"));
    if (c === "btc")   checks.push(InputValidator.isBtcAddress(address, "address"));
    if (c === "zcash") checks.push(InputValidator.isZecAddress(address, "address"));
    return InputValidator.run(checks);
  }

  static walletPropose(chain: unknown, to: unknown, value: unknown, valueRaw: unknown): ValidationResult {
    const c = chain as string;
    const checks: Array<string | null> = [
      InputValidator.isEnum(chain, "chain", ["evm", "btc", "zcash"]),
      InputValidator.isAmountString(value, "value"),
      InputValidator.isBigIntPositive(valueRaw, "valueRaw"),
    ];
    if (c === "evm")   checks.push(InputValidator.isEvmAddress(to, "to"));
    if (c === "btc")   checks.push(InputValidator.isBtcAddress(to, "to"));
    if (c === "zcash") checks.push(InputValidator.isZecAddress(to, "to"));
    return InputValidator.run(checks);
  }

  // ── Scheduler payloads ──────────────────────────────────────────────────────

  static schedulerAddJob(id: unknown, name: unknown, commands: unknown, intervalMs: unknown, maxRuns: unknown): ValidationResult {
    return InputValidator.run([
      InputValidator.isSafeFilename(id, "id"),
      InputValidator.isSafeText(name, "name", 128),
      Array.isArray(commands) && commands.length > 0
        ? null
        : "commands must be a non-empty array",
      InputValidator.isPositiveNumber(intervalMs, "intervalMs"),
      InputValidator.isNonNegativeInteger(maxRuns, "maxRuns"),
    ]);
  }

  // ── Vault payloads ──────────────────────────────────────────────────────────

  static vaultKeyName(name: unknown): ValidationResult {
    return InputValidator.run([
      InputValidator.isVaultKeyName(name, "name"),
    ]);
  }

  // ── Hash helper for logging ─────────────────────────────────────────────────

  static hashForLog(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }
}
