import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBox } from "./secret-box";

describe("SecretBox", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips and uses a fresh IV each time", () => {
    const box = new SecretBox(key);
    const a = box.encrypt("xoxb-secret");
    expect(a).not.toContain("xoxb");
    expect(a).not.toBe(box.encrypt("xoxb-secret"));
    expect(box.decrypt(a)).toBe("xoxb-secret");
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const sealed = new SecretBox(key).encrypt("xoxb-secret");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => new SecretBox(key).decrypt(parts.join("."))).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString("base64")).decrypt(sealed)).toThrow();
  });

  it("rejects a truncated auth tag", () => {
    const box = new SecretBox(key);
    const parts = box.encrypt("xoxb-secret").split(".");
    // A 4-byte prefix of the real tag: GCM would accept it unless the length is pinned.
    parts[2] = Buffer.from(parts[2]!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => box.decrypt(parts.join("."))).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => new SecretBox(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
