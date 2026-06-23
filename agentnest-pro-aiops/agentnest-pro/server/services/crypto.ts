import crypto from "crypto";

const IV_LENGTH = 16;
let ENCRYPTION_KEY: Buffer | null = null;

export function initCrypto(jwtSecret: string) {
  ENCRYPTION_KEY = crypto.scryptSync(jwtSecret, "agentnest-v1-salt", 32);
}

function getKey(): Buffer {
  if (!ENCRYPTION_KEY) throw new Error("Crypto not initialized — call initCrypto() before use");
  return ENCRYPTION_KEY;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  try {
    const [ivHex, encHex] = ciphertext.split(":");
    if (!ivHex || !encHex) return "[invalid-ciphertext]";
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "[decryption-failed]";
  }
}

export function mask(_value: string): string {
  return "••••••••";
}

export function isEncrypted(value: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]+$/i.test(value);
}

export function safeDecryptSetting(value: string, isSecret: number | boolean): string {
  if (!isSecret) return value;
  if (!value || value === "") return "";
  try {
    return isEncrypted(value) ? decrypt(value) : value;
  } catch {
    return "[decryption-failed]";
  }
}
