import { createHmac } from "node:crypto";
import { safeEqual } from "../crypto/digest";

/** Verifies GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  return safeEqual(signWebhookBody(secret, rawBody), signatureHeader);
}

export function signWebhookBody(secret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
