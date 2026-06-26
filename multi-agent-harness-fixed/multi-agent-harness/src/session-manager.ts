// src/session-manager.ts
// Session lifecycle — rotation, concurrent control, fingerprinting, replay defense.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { MerkleLog } from "./merkle-log.js";
import { zeroBuffer } from "./crypto-vault.js";

const SESSION_TTL_MS      = 30 * 60 * 1000;
const MAX_CONCURRENT      = 1;
const ROTATION_INTERVAL   = 10 * 60 * 1000;
const REPLAY_WINDOW_MS    = 60_000;

export interface SessionRecord {
  id:          string;
  fingerprint: string;
  createdAt:   number;
  expiresAt:   number;
  lastUsed:    number;
  rotatedAt:   number;
  ops:         string[];
}

export class SessionManager {
  private sessions    = new Map<string, SessionRecord>();
  private signingKey: Buffer;
  private log:        MerkleLog;
  private usedNonces  = new Set<string>();
  private nonceExpiry = new Map<string, number>();

  constructor(log: MerkleLog) {
    this.log        = log;
    this.signingKey = randomBytes(32);
  }

  private fingerprint(): string {
    return createHash("sha256")
      .update(`${process.pid}:${process.platform}:${process.version}`)
      .digest("hex")
      .slice(0, 32);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("hex");
  }

  private verify(payload: string, sig: string): boolean {
    const expected = this.sign(payload);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig,      "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  create(ops: string[] = ["*"]): string {
    if (this.sessions.size >= MAX_CONCURRENT) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) {
        this.log.append("session:evict", { id: oldest[0].slice(0, 8) }, { ok: true });
        this.sessions.delete(oldest[0]);
      }
    }

    const id  = randomBytes(16).toString("hex");
    const now = Date.now();
    const record: SessionRecord = {
      id,
      fingerprint: this.fingerprint(),
      createdAt:   now,
      expiresAt:   now + SESSION_TTL_MS,
      lastUsed:    now,
      rotatedAt:   now,
      ops,
    };

    this.sessions.set(id, record);
    const payload = `${id}:${record.expiresAt}:${ops.join(",")}`;
    const token   = `${payload}.${this.sign(payload)}`;
    this.log.append("session:create", { id: id.slice(0, 8), ops }, { ok: true });
    return token;
  }

  validate(token: string, op = "*"): { valid: boolean; reason?: string } {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return { valid: false, reason: "malformed token" };

    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);

    if (!this.verify(payload, sig)) {
      this.log.append("session:tampered", {}, { ok: false });
      return { valid: false, reason: "token signature invalid" };
    }

    const parts = payload.split(":");
    if (parts.length < 3) return { valid: false, reason: "malformed payload" };

    const id  = parts[0];
    const exp = parseInt(parts[1], 10);

    if (Date.now() > exp) {
      this.sessions.delete(id);
      this.log.append("session:expired", { id: id.slice(0, 8) }, { ok: false });
      return { valid: false, reason: "session expired" };
    }

    const record = this.sessions.get(id);
    if (!record) {
      this.log.append("session:unknown", { id: id.slice(0, 8) }, { ok: false });
      return { valid: false, reason: "session not found" };
    }

    if (record.fingerprint !== this.fingerprint()) {
      this.log.append("session:fingerprint-mismatch", { id: id.slice(0, 8) }, { ok: false });
      return { valid: false, reason: "session fingerprint mismatch — possible hijack" };
    }

    const allowed = record.ops.includes("*") || record.ops.includes(op);
    if (!allowed) {
      this.log.append("session:op-denied", { id: id.slice(0, 8), op }, { ok: false });
      return { valid: false, reason: `op "${op}" not in session scope` };
    }

    record.lastUsed = Date.now();

    if (Date.now() - record.rotatedAt > ROTATION_INTERVAL) {
      this.rotate(id, token);
    }

    this.log.append("session:ok", { id: id.slice(0, 8), op }, { ok: true });
    return { valid: true };
  }

  private rotate(id: string, _oldToken: string) {
    const record = this.sessions.get(id);
    if (!record) return;
    record.rotatedAt  = Date.now();
    record.expiresAt  = Date.now() + SESSION_TTL_MS;
    this.log.append("session:rotated", { id: id.slice(0, 8) }, { ok: true });
  }

  checkNonce(nonce: string): boolean {
    const now = Date.now();
    // Purge expired nonces
    for (const [n, exp] of this.nonceExpiry.entries()) {
      if (now > exp) { this.usedNonces.delete(n); this.nonceExpiry.delete(n); }
    }
    if (this.usedNonces.has(nonce)) {
      this.log.append("session:replay-detected", { nonce: nonce.slice(0, 8) }, { ok: false });
      return false;
    }
    this.usedNonces.add(nonce);
    this.nonceExpiry.set(nonce, now + REPLAY_WINDOW_MS);
    return true;
  }

  invalidate(token: string) {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return;
    const id = token.slice(0, token.indexOf(":"));
    this.sessions.delete(id);
    this.log.append("session:invalidated", { id: id.slice(0, 8) }, { ok: true });
  }

  destroy() {
    this.sessions.clear();
    zeroBuffer(this.signingKey);
    this.usedNonces.clear();
    this.nonceExpiry.clear();
    this.log.append("session:destroy", {}, { ok: true });
  }

  printStatus() {
    console.log("\n─────────────────────────────────────────");
    console.log(`  SESSIONS  (${this.sessions.size} active)`);
    for (const r of this.sessions.values()) {
      const ttl = Math.ceil((r.expiresAt - Date.now()) / 1000);
      console.log(`  ${r.id.slice(0, 8)}…  ops: ${r.ops.join(",")}  ttl: ${ttl}s`);
    }
    console.log("─────────────────────────────────────────\n");
  }
}
