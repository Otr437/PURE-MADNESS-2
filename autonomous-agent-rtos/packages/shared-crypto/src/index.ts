import * as crypto from "crypto";

export class EncryptionService {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex?: string) {
    this.masterKey = masterKeyHex
      ? Buffer.from(masterKeyHex, "hex")
      : crypto.randomBytes(32);
  }

  encrypt(plaintext: string | object): string {
    const data =
      typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    let encrypted = cipher.update(data, "utf8", "base64");
    encrypted += cipher.final("base64");
    const authTag = cipher.getAuthTag();
    return [
      iv.toString("base64"),
      encrypted,
      authTag.toString("base64"),
    ].join("~");
  }

  decrypt(ciphertext: string): string {
    const [ivB64, encryptedB64, authTagB64] = ciphertext.split("~");
    if (!ivB64 || !encryptedB64 || !authTagB64) {
      throw new Error("Invalid ciphertext format");
    }
    const iv = Buffer.from(ivB64, "base64");
    const encrypted = Buffer.from(encryptedB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      iv
    );
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString("utf8");
  }

  hash(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  generateToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString("hex");
  }

  getMasterKey(): string {
    return this.masterKey.toString("hex");
  }
}
