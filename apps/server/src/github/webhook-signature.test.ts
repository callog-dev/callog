import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "./webhook-signature";

describe("verifyWebhookSignature", () => {
  const body = Buffer.from('{"a":1}');

  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature("s3cret", body, signWebhookBody("s3cret", body))).toBe(true);
  });

  it.each([
    ["wrong secret", signWebhookBody("other", body)],
    ["missing header", undefined],
    ["sha1 header", "sha1=abc"],
    ["truncated", signWebhookBody("s3cret", body).slice(0, -2)],
  ])("rejects %s", (_, header) => {
    expect(verifyWebhookSignature("s3cret", body, header)).toBe(false);
  });

  it("rejects a modified body", () => {
    const sig = signWebhookBody("s3cret", body);
    expect(verifyWebhookSignature("s3cret", Buffer.from('{"a":2}'), sig)).toBe(false);
  });
});
