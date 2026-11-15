import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Hex SHA-256; secrets we only need to recognise (API keys, tokens) are stored this way. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A new 256-bit secret with a recognisable prefix (`ntf_`, `hk_`). Only `hash` is stored;
 * `display` is its first characters, enough to tell two secrets apart in the UI.
 */
export function mintSecret(prefix: string): { secret: string; display: string; hash: string } {
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { secret, display: secret.slice(0, prefix.length + 6), hash: sha256Hex(secret) };
}

/** Constant-time comparison for tokens and signatures. */
export function safeEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
