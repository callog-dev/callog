import { createHash, timingSafeEqual } from "node:crypto";

/** Hex SHA-256; secrets we only need to recognise (API keys, tokens) are stored this way. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison for tokens and signatures. */
export function safeEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
