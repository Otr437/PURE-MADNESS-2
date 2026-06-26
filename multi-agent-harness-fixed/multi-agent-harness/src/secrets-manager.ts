// src/secrets-manager.ts
// Centralized secret access — zero scattered process.env reads anywhere else.
// All secrets fetched through here, never stored as strings after retrieval.

import { randomBytes } from "crypto";
import { CryptoVault, zeroBuffer } from "./crypto-vault.js";
import { MerkleLog } from "./merkle-log.js";
import type { ValidatedConfig } from "./config-validator.js";

export class SecretsManager {
  private vault:  CryptoVault;
  private log:    MerkleLog;
  private config: ValidatedConfig;

  constructor(vault: CryptoVault, log: MerkleLog, config: ValidatedConfig) {
    this.vault  = vault;
    this.log    = log;
    this.config = config;
  }

  // ── API keys — returned as Buffer, caller zeros after use ──────────────────
  getAnthropicKey(): Buffer {
    this.log.append("secrets:access", { key: "anthropic-api-key" }, { ok: true });
    return Buffer.from(this.config.anthropicApiKey, "utf8");
  }

  getOpenAiKey(): Buffer | null {
    if (!this.config.openaiApiKey) return null;
    this.log.append("secrets:access", { key: "openai-api-key" }, { ok: true });
    return Buffer.from(this.config.openaiApiKey, "utf8");
  }

  getGroqKey(): Buffer | null {
    if (!this.config.groqApiKey) return null;
    this.log.append("secrets:access", { key: "groq-api-key" }, { ok: true });
    return Buffer.from(this.config.groqApiKey, "utf8");
  }

  getDeepSeekKey(): Buffer | null {
    if (!this.config.deepseekApiKey) return null;
    this.log.append("secrets:access", { key: "deepseek-api-key" }, { ok: true });
    return Buffer.from(this.config.deepseekApiKey, "utf8");
  }

  // ── RPC endpoints — not secret but centralized ────────────────────────────
  getEvmRpcUrl(): string   { return this.config.evmRpcUrl; }
  getZcashRpcUrl(): string | null { return this.config.zcashRpcUrl; }

  // ── Vault-stored secrets — decrypted on demand, zeroed by caller ──────────
  loadFromVault(name: string, pinBuf: Buffer): string {
    this.log.append("secrets:vault-load", { name }, { ok: true });
    return this.vault.loadDecrypted(name, pinBuf);
  }

  saveToVault(name: string, value: string, pinBuf: Buffer): void {
    this.vault.saveEncrypted(name, value, pinBuf);
    this.log.append("secrets:vault-save", { name }, { ok: true });
  }

  vaultHas(name: string): boolean {
    return this.vault.has(name);
  }

  // ── Generate a cryptographically random token ─────────────────────────────
  generateToken(byteLen = 32): string {
    return randomBytes(byteLen).toString("hex");
  }

  // ── Spending rule accessors — config-driven, not hardcoded ────────────────
  getSpendingRules() {
    return {
      maxPerTx: {
        evm:   String(this.config.maxTxEth),
        btc:   String(this.config.maxTxBtc),
        zcash: String(this.config.maxTxZec),
      },
      maxPerSession: {
        evm:   String(this.config.maxSessionEth),
        btc:   String(this.config.maxSessionBtc),
        zcash: String(this.config.maxSessionZec),
      },
      maxTxPerSession: this.config.maxTxCount,
      requireApproval: true,
    };
  }
}
