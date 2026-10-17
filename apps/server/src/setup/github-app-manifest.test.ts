import { generateKeyPairSync } from "node:crypto";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadGithubAppConfig } from "../github/github.config";
import { loadEnv } from "../config/env";
import { buildManifest, defaultAppName, envBlock, isLocalUrl } from "./github-app-manifest";

describe("isLocalUrl", () => {
  it.each([
    ["http://localhost:3000", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:3000", true],
    ["http://callog.localhost", true],
    ["https://callog.test", true],
    ["https://callog.acme.dev", false],
  ])("%s → %s", (url, local) => {
    expect(isLocalUrl(url)).toBe(local);
  });
});

describe("buildManifest", () => {
  it("points GitHub back at this server", () => {
    const manifest = buildManifest({
      publicUrl: "https://callog.acme.dev/",
      webhookUrl: "https://callog.acme.dev/webhooks/github",
      name: "Callog acme",
    });
    expect(manifest.redirect_url).toBe("https://callog.acme.dev/setup/github-app/callback");
    expect(manifest.callback_urls).toEqual(["https://callog.acme.dev/oauth/github/callback"]);
    expect(manifest.hook_attributes).toEqual({
      url: "https://callog.acme.dev/webhooks/github",
      active: true,
    });
    expect(manifest.default_events).toEqual(["push", "organization"]);
  });

  it("keeps the default name within GitHub's limit", () => {
    expect(defaultAppName("a".repeat(39))).toHaveLength(34);
  });
});

describe("envBlock", () => {
  it("survives a .env round trip into a working App config", () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const block = envBlock({
      id: 42,
      slug: "callog-acme",
      html_url: "https://github.com/apps/callog-acme",
      owner: { login: "acme" },
      pem,
      webhook_secret: "whsec",
      client_id: "Iv1.abc",
      client_secret: "cs",
    });
    const env = loadEnv({ DATABASE_URL: "postgres://u:p@db:5432/notify", ...parseEnv(block) });
    expect(loadGithubAppConfig(env)).toEqual({
      appId: 42,
      privateKey: pem,
      webhookSecret: "whsec",
    });
    expect(env.GITHUB_APP_CLIENT_ID).toBe("Iv1.abc");
  });
});
