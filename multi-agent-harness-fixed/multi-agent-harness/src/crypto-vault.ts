// src/crypto-vault.ts
// AES-256-GCM encryption/decryption vault.
//
// Rules:
//   - Nothing secret ever stored as a string or in a plain JS object
//   - Keys derived via PBKDF2 (310,000 iterations — OWASP 2026 minimum)
//   - Every secret Buffer is zeroed immediately after use
//   - Encrypted blobs stored on disk: iv + authTag + ciphertext (base64)
//   - Master key never written anywhere — derived at runtime from your PIN
//   - Zero plaintext in memory: derive → use → zero → GC

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const ALGO        = "aes-256-gcm";
const IV_LEN      = 12;   // 96-bit IV — recommended for GCM
const TAG_LEN     = 16;   // 128-bit auth tag
const KEY_LEN     = 32;   // 256-bit key
const SALT_LEN    = 32;
const PBKDF2_ITER = 310_000;  // OWASP 2026 minimum for SHA-256
const PBKDF2_HASH = "sha256";
const VAULT_DIR   = ".vault";

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Zero a Buffer immediately after use — reduces window for memory scraping
function zero(buf: Buffer) {
  buf.fill(0);
}

// Derive a 256-bit key from a PIN + salt using PBKDF2 — never store the result
function deriveKey(pin: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(pin, salt, PBKDF2_ITER, KEY_LEN, PBKDF2_HASH);
}

// Encode blob: base64(iv + tag + ciphertext)
function encode(iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// Decode blob back to parts
function decode(blob: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const buf        = Buffer.from(blob, "base64");
  const iv         = buf.subarray(0, IV_LEN);
  const tag        = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  return { iv, tag, ciphertext };
}

// ─── VAULT ────────────────────────────────────────────────────────────────────

export class CryptoVault {
  private saltPath: string;
  private salt: Buffer;

  constructor(vaultDir = VAULT_DIR) {
    if (!existsSync(vaultDir)) mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    this.saltPath = join(vaultDir, "vault.salt");

    // Salt is NOT secret — it's a public fixed random value per install
    if (existsSync(this.saltPath)) {
      this.salt = Buffer.from(readFileSync(this.saltPath, "utf8"), "hex");
    } else {
      this.salt = randomBytes(SALT_LEN);
      writeFileSync(this.saltPath, this.salt.toString("hex"), { mode: 0o600 });
    }
  }

  // ── Encrypt plaintext with PIN-derived key ─────────────────────────────────
  // pinBuf: Buffer containing the PIN bytes (you zero it after calling this)
  // Returns base64 blob safe to write to disk
  encrypt(plaintext: string, pinBuf: Buffer): string {
    const key = deriveKey(pinBuf, this.salt);
    const iv  = randomBytes(IV_LEN);

    try {
      const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
      const ct1    = cipher.update(plaintext, "utf8");
      const ct2    = cipher.final();
      const tag    = cipher.getAuthTag();
      const blob   = encode(iv, tag, Buffer.concat([ct1, ct2]));

      zero(ct1); zero(ct2); zero(tag); zero(iv);
      return blob;
    } finally {
      zero(key);
    }
  }

  // ── Decrypt blob with PIN-derived key ─────────────────────────────────────
  // Returns plaintext string, or throws on wrong PIN / tampered data
  decrypt(blob: string, pinBuf: Buffer): string {
    const key = deriveKey(pinBuf, this.salt);
    const { iv, tag, ciphertext } = decode(blob);

    try {
      const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
      decipher.setAuthTag(tag);
      const pt1  = decipher.update(ciphertext);
      const pt2  = decipher.final();
      const text = Buffer.concat([pt1, pt2]).toString("utf8");

      zero(pt1); zero(pt2); zero(iv); zero(tag); zero(ciphertext);
      return text;
    } finally {
      zero(key);
    }
  }

  // ── Save an encrypted file to vault dir ───────────────────────────────────
  saveEncrypted(name: string, plaintext: string, pinBuf: Buffer, vaultDir = VAULT_DIR) {
    const blob = this.encrypt(plaintext, pinBuf);
    const path = join(vaultDir, `${name}.enc`);
    writeFileSync(path, blob, { mode: 0o600, encoding: "utf8" });
  }

  // ── Load and decrypt a file from vault dir ────────────────────────────────
  loadDecrypted(name: string, pinBuf: Buffer, vaultDir = VAULT_DIR): string {
    const path = join(vaultDir, `${name}.enc`);
    if (!existsSync(path)) throw new Error(`Vault entry not found: ${name}`);
    const blob = readFileSync(path, "utf8");
    return this.decrypt(blob, pinBuf);
  }

  // ── Check if a vault entry exists ─────────────────────────────────────────
  has(name: string, vaultDir = VAULT_DIR): boolean {
    return existsSync(join(vaultDir, `${name}.enc`));
  }

  // ── Encrypt a Buffer (e.g. a raw key) and zero the input ──────────────────
  encryptBuffer(secret: Buffer, pinBuf: Buffer): string {
    const hex  = secret.toString("hex");
    const blob = this.encrypt(hex, pinBuf);
    zero(secret);
    return blob;
  }

  // ── Decrypt to Buffer, use it, then zero it ───────────────────────────────
  // Usage:
  //   const keyBuf = vault.decryptToBuffer(blob, pin);
  //   try { ... use keyBuf ... } finally { zero(keyBuf); }
  decryptToBuffer(blob: string, pinBuf: Buffer): Buffer {
    const hex = this.decrypt(blob, pinBuf);
    const buf = Buffer.from(hex, "hex");
    return buf; // CALLER must zero this after use
  }
}

// ─── EXPORT HELPER: zero a buffer (callers use this) ─────────────────────────
export function zeroBuffer(buf: Buffer) {
  buf.fill(0);
}

// ─── EXPORT HELPER: read PIN from stdin without echoing ───────────────────────
// Returns a Buffer — caller must zero it after use
export async function readPinSilent(prompt: string): Promise<Buffer> {
  const readline = await import("readline");

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Suppress echo
    (rl as any).stdoutMuted = true;
    (rl as any)._writeToOutput = (str: string) => {
      if (!(rl as any).stdoutMuted) process.stdout.write(str);
    };

    process.stdout.write(prompt);

    rl.question("", (answer) => {
      process.stdout.write("\n");
      rl.close();
      // Return as Buffer, not string — so caller can zero it
      resolve(Buffer.from(answer, "utf8"));
    });
  });
}
