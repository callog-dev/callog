import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

/**
 * Encrypts provider secrets (bot tokens) at rest with AES-256-GCM.
 * Format: `v1.<iv>.<tag>.<ciphertext>`, base64url parts.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32) {
      throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Malformed secret");
    // A pinned tag length: GCM otherwise accepts a truncated (forgeable) tag.
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "base64url"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
