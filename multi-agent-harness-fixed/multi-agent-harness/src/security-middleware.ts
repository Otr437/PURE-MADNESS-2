// src/security-middleware.ts
// Auth + input validation gate on every endpoint and tool call.
// Nothing executes unless it passes through here first.
// Every gate logs to the Merkle tree.

import { AuthManager } from "./auth.js";
import { InputValidator, type ValidationResult } from "./input-validator.js";
import { MerkleLog } from "./merkle-log.js";
import { PromptGuard } from "./prompt-guard.js";

export interface GateResult {
  allowed: boolean;
  reason?: string;
  validation?: ValidationResult;
}

export class SecurityMiddleware {
  private auth:  AuthManager;
  private guard: PromptGuard;
  private log:   MerkleLog;

  constructor(auth: AuthManager, guard: PromptGuard, log: MerkleLog) {
    this.auth  = auth;
    this.guard = guard;
    this.log   = log;
  }

  // ── Generic gate: auth check + custom validation ───────────────────────────
  gate(op: string, validation: ValidationResult): GateResult {
    if (!this.auth.check(op)) {
      this.log.append("middleware:denied", { op, reason: "not authenticated" }, { ok: false });
      return { allowed: false, reason: "Not authenticated. Run: auth login" };
    }
    if (!validation.valid) {
      this.log.append("middleware:invalid", { op, errors: validation.errors }, { ok: false });
      return { allowed: false, reason: `Validation failed: ${validation.errors.join("; ")}`, validation };
    }
    this.log.append("middleware:allowed", { op }, { ok: true });
    return { allowed: true, validation };
  }

  // ── Browser tool gates ─────────────────────────────────────────────────────

  browserNavigate(args: unknown): GateResult {
    const v = InputValidator.browserNavigate(args);
    const g = this.gate("browser:navigate", v);
    if (g.allowed) {
      const url = (args as any)?.url ?? "";
      const urlCheck = this.guard.checkUrl(url);
      if (!urlCheck.allowed) {
        this.log.append("middleware:url-blocked", { url: url.slice(0, 60) }, { ok: false });
        return { allowed: false, reason: `URL blocked: ${urlCheck.reason}` };
      }
    }
    return g;
  }

  browserClick(args: unknown):        GateResult { return this.gate("browser:click",         InputValidator.browserClick(args)); }
  browserTypeText(args: unknown):     GateResult { return this.gate("browser:type_text",      InputValidator.browserTypeText(args)); }
  browserReadPage(args: unknown):     GateResult { return this.gate("browser:read_page",      InputValidator.browserReadPage(args)); }
  browserScreenshot(args: unknown):   GateResult { return this.gate("browser:screenshot",     InputValidator.browserScreenshot(args)); }
  browserScroll(args: unknown):       GateResult { return this.gate("browser:scroll",         InputValidator.browserScroll(args)); }
  browserRunJs(args: unknown):        GateResult { return this.gate("browser:run_js",         InputValidator.browserRunJs(args)); }
  browserExtract(args: unknown):      GateResult { return this.gate("browser:extract",        InputValidator.browserExtract(args)); }
  browserSelectOption(args: unknown): GateResult { return this.gate("browser:select_option",  InputValidator.browserSelectOption(args)); }
  browserCheckBox(args: unknown):     GateResult { return this.gate("browser:check_box",      InputValidator.browserCheckBox(args)); }
  browserHover(args: unknown):        GateResult { return this.gate("browser:hover",          InputValidator.browserHover(args)); }
  browserWaitFor(args: unknown):      GateResult { return this.gate("browser:wait_for",       InputValidator.browserWaitFor(args)); }
  browserPageInfo(args: unknown):     GateResult { return this.gate("browser:page_info",      InputValidator.run([])); }
  browserHistory(args: unknown):      GateResult {
    const a = args as any;
    return this.gate("browser:navigate_history", InputValidator.run([
      InputValidator.isEnum(a?.direction, "direction", ["back", "forward"]),
    ]));
  }

  // ── Wallet gates ───────────────────────────────────────────────────────────

  walletRegister(chain: unknown, address: unknown, path: unknown): GateResult {
    return this.gate("wallet:register", InputValidator.walletRegister(chain, address, path));
  }

  walletStoreKey(chain: unknown): GateResult {
    return this.gate("wallet:storekey", InputValidator.run([
      InputValidator.isEnum(chain, "chain", ["evm", "btc", "zcash"]),
    ]));
  }

  walletPropose(chain: unknown, to: unknown, value: unknown, valueRaw: unknown): GateResult {
    return this.gate("wallet:propose", InputValidator.walletPropose(chain, to, value, valueRaw));
  }

  walletApprove(): GateResult {
    return this.gate("wallet:approve", InputValidator.run([]));
  }

  walletExecute(): GateResult {
    return this.gate("wallet:execute", InputValidator.run([]));
  }

  // ── Scheduler gates ────────────────────────────────────────────────────────

  schedulerAdd(id: unknown, name: unknown, commands: unknown, intervalMs: unknown, maxRuns: unknown): GateResult {
    return this.gate("scheduler:add", InputValidator.schedulerAddJob(id, name, commands, intervalMs, maxRuns));
  }

  schedulerStart():           GateResult { return this.gate("scheduler:start",  InputValidator.run([])); }
  schedulerStop():            GateResult { return this.gate("scheduler:stop",   InputValidator.run([])); }
  schedulerToggle(id: unknown): GateResult {
    return this.gate("scheduler:toggle", InputValidator.run([
      InputValidator.isSafeFilename(id, "id"),
    ]));
  }

  // ── Vault gates ────────────────────────────────────────────────────────────

  vaultEncrypt(name: unknown): GateResult {
    return this.gate("vault:encrypt", InputValidator.vaultKeyName(name));
  }

  vaultDecrypt(name: unknown): GateResult {
    return this.gate("vault:decrypt", InputValidator.vaultKeyName(name));
  }

  // ── Command gate (prompt injection + auth) ─────────────────────────────────

  command(rawCmd: unknown): GateResult {
    const textCheck = InputValidator.isSafeCommand(rawCmd, "command");
    if (textCheck) {
      this.log.append("middleware:bad-command", { error: textCheck }, { ok: false });
      return { allowed: false, reason: textCheck };
    }
    if (!this.auth.check()) {
      return { allowed: false, reason: "Not authenticated. Run: auth login" };
    }
    const g = this.guard.checkCommand(rawCmd as string);
    if (!g.safe) {
      return { allowed: false, reason: `Injection blocked: ${g.threats.join("; ")}` };
    }
    return { allowed: true };
  }

  // ── Page content sanitization gate ────────────────────────────────────────

  pageContent(text: string, url: string): { text: string; injectionFound: boolean } {
    const result = this.guard.sanitizePage(text, url);
    if (!result.safe) {
      this.guard.printThreats(result, url);
    }
    return { text: result.cleaned, injectionFound: !result.safe };
  }
}
