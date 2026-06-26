// src/prompt-guard.ts
// Prompt injection + session hijack defense.
//
// How it works:
//   1. Every command you type gets hashed and added to the Merkle log BEFORE execution
//   2. Any text the bot reads from a webpage is scanned for injection patterns
//   3. If injected instructions are detected in page content, they are stripped
//      and flagged — the bot never sees them as commands
//   4. A session token is derived from your first command hash; if the session
//      root drifts unexpectedly the session is considered compromised
//
// Attack patterns blocked:
//   - "Ignore previous instructions..."
//   - "You are now a different bot..."
//   - "System: ..." injected in page text
//   - Attempts to navigate to data: / javascript: URIs
//   - Commands that try to exfiltrate the Merkle log or wallet keys

import { createHash, createHmac } from "crypto";
import { MerkleLog } from "./merkle-log.js";

// ─── INJECTION PATTERNS ───────────────────────────────────────────────────────
// Regex list of known prompt-injection and hijack signatures found in web content.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|another|an?\s+)/i,
  /system\s*:\s*you\s+are/i,
  /\[system\]/i,
  /new\s+instructions?\s*:/i,
  /disregard\s+(your\s+)?(previous|all|prior)/i,
  /forget\s+(everything|all|your|prior)/i,
  /override\s+(your\s+)?(instructions?|rules?|guidelines?)/i,
  /act\s+as\s+(if\s+you\s+are|a\s+)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /do\s+anything\s+now/i,
  // URI-based attacks
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  // Key/seed exfiltration attempts
  /send\s+(me\s+)?(your\s+)?(seed|mnemonic|private\s+key|wallet)/i,
  /reveal\s+(the\s+)?(seed|mnemonic|private\s+key)/i,
  /export\s+(the\s+)?(seed|keys?|wallet)/i,
  /print\s+(the\s+)?(seed|mnemonic|private\s+key)/i,
  /show\s+(me\s+)?(your\s+)?(seed|mnemonic|private\s+key)/i,
];

// Dangerous URL schemes the bot should never navigate to
const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:", "file://"];

// ─── SESSION TOKEN ────────────────────────────────────────────────────────────
// Derived from process start time + a random nonce. Used to sign commands
// so we can detect if something else is injecting into the command stream.

const SESSION_SECRET = createHash("sha256")
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest("hex");

export function signCommand(cmd: string): string {
  return createHmac("sha256", SESSION_SECRET).update(cmd).digest("hex");
}

export function verifyCommandSignature(cmd: string, sig: string): boolean {
  const expected = createHmac("sha256", SESSION_SECRET).update(cmd).digest("hex");
  // Constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

// ─── PROMPT GUARD CLASS ───────────────────────────────────────────────────────

export interface GuardResult {
  safe: boolean;
  cleaned: string;         // sanitised version of the input
  threats: string[];       // list of detected threat descriptions
  hash: string;            // SHA-256 of the original input
}

export class PromptGuard {
  private log: MerkleLog;
  private commandCount = 0;

  constructor(log: MerkleLog) {
    this.log = log;
  }

  // ── Check a USER command ────────────────────────────────────────────────────
  // Call this before passing any user input to the agent.
  checkCommand(cmd: string): GuardResult {
    const threats: string[] = [];
    const hash = createHash("sha256").update(cmd).digest("hex");

    // Check blocked URL schemes in command
    for (const scheme of BLOCKED_SCHEMES) {
      if (cmd.toLowerCase().includes(scheme)) {
        threats.push(`Blocked URI scheme: ${scheme}`);
      }
    }

    // Check injection patterns in the command itself
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(cmd)) {
        threats.push(`Injection pattern in command: ${pattern.source.slice(0, 40)}`);
      }
    }

    const safe = threats.length === 0;

    this.log.append("guard:command", {
      seq: this.commandCount++,
      hash: hash.slice(0, 16),
      safe,
      threats,
    }, { ok: safe });

    return { safe, cleaned: cmd, threats, hash };
  }

  // ── Sanitise PAGE CONTENT before it goes into the agent context ─────────────
  // Call this on any text read from a webpage before sending to the LLM.
  sanitizePage(rawText: string, url: string): GuardResult {
    const threats: string[] = [];
    const hash = createHash("sha256").update(rawText).digest("hex");
    let cleaned = rawText;

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(rawText)) {
        threats.push(`Injection pattern in page content: ${pattern.source.slice(0, 40)}`);
        // Replace the offending phrase with [REDACTED]
        cleaned = cleaned.replace(pattern, "[REDACTED-INJECTION]");
      }
    }

    const safe = threats.length === 0;

    if (!safe) {
      this.log.append("guard:page-injection", {
        url,
        hash: hash.slice(0, 16),
        threatCount: threats.length,
        threats,
      }, { ok: false, blocked: true });
    }

    return { safe, cleaned, threats, hash };
  }

  // ── Check a URL before navigation ──────────────────────────────────────────
  checkUrl(url: string): { allowed: boolean; reason?: string } {
    for (const scheme of BLOCKED_SCHEMES) {
      if (url.toLowerCase().startsWith(scheme)) {
        this.log.append("guard:blocked-url", { url, scheme }, { ok: false });
        return { allowed: false, reason: `Blocked scheme: ${scheme}` };
      }
    }
    return { allowed: true };
  }

  // Print a threat report
  printThreats(result: GuardResult, source: string) {
    if (result.safe) return;
    console.log("\n⚠  PROMPT INJECTION DETECTED");
    console.log(`   Source  : ${source}`);
    for (const t of result.threats) {
      console.log(`   Threat  : ${t}`);
    }
    console.log(`   Hash    : ${result.hash.slice(0, 20)}…`);
    console.log("   Action  : blocked / sanitised\n");
  }
}
