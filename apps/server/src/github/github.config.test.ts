import { App } from "@octokit/app";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env";
import { loadGithubAppConfig, normalizePrivateKey } from "./github.config";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

const BASE64 = Buffer.from(PEM).toString("base64");

describe("normalizePrivateKey", () => {
  it.each([
    ["PEM", PEM],
    ["PEM with \\n escapes", PEM.replace(/\n/g, "\\n")],
    ["base64 of the PEM", BASE64],
    ["base64 wrapped over lines", BASE64.replace(/(.{64})/g, "$1\n")],
  ])("accepts %s", (_, value) => {
    expect(normalizePrivateKey(value)).toBe(PEM);
  });

  it.each(["not a key", Buffer.from("hello").toString("base64")])("rejects %s", (value) => {
    expect(() => normalizePrivateKey(value)).toThrow("is neither a PEM key nor base64 of one");
  });
});

describe("loadGithubAppConfig", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@db:5432/notify",
    GITHUB_APP_ID: "7",
    GITHUB_WEBHOOK_SECRET: "s",
  };

  // Octokit, not just a string comparison: the decoded key has to be usable for the App's JWT.
  it("signs the App's JWT with a base64 key", async () => {
    const env = loadEnv({ ...base, GITHUB_APP_PRIVATE_KEY: BASE64 });
    const { privateKey, appId } = loadGithubAppConfig(env)!;
    const { token } = (await new App({ appId, privateKey }).octokit.auth({ type: "app" })) as {
      token: string;
    };
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())).toMatchObject({
      iss: 7,
    });
  });

  it("accepts a base64 key file", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "callog-key-")), "key");
    writeFileSync(file, `${BASE64}\n`);
    const env = loadEnv({ ...base, GITHUB_APP_PRIVATE_KEY_PATH: file });
    expect(loadGithubAppConfig(env)?.privateKey).toBe(PEM);
  });
});
