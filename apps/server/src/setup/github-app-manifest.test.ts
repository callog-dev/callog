import { generateKeyPairSync } from "node:crypto";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadGithubAppConfig } from "../github/github.config";
import { loadEnv } from "../config/env";
import {
  buildManifest,
  defaultAppName,
  envBlock,
  isLocalUrl,
  isPublicHttpsUrl,
  resolveWebhookUrl,
} from "./github-app-manifest";

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

describe("isPublicHttpsUrl", () => {
  it.each([
    ["https://hooks.acme.dev/webhooks/github", true],
    ["http://hooks.acme.dev/webhooks/github", false],
    ["https://localhost/webhooks/github", false],
    ["https://", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => {
    expect(isPublicHttpsUrl(url)).toBe(ok);
  });
});

describe("resolveWebhookUrl", () => {
  const configured = "https://hooks.acme.dev/webhooks/github";
  const relay = "https://smee.io/abc";

  it("prefers GITHUB_WEBHOOK_URL, for a public and a local server alike", () => {
    for (const publicUrl of ["https://callog.acme.dev", "http://localhost:3000"]) {
      expect(resolveWebhookUrl({ publicUrl, configured, relay })).toEqual({
        url: configured,
        pathMismatch: false,
      });
    }
  });

  it("rejects a GITHUB_WEBHOOK_URL GitHub cannot reach and flags another path", () => {
    const publicUrl = "https://callog.acme.dev";
    expect(resolveWebhookUrl({ publicUrl, configured: "http://hooks.acme.dev/x" })).toEqual({
      error: "configured",
    });
    expect(
      resolveWebhookUrl({ publicUrl, configured: "https://hooks.acme.dev/github" }),
    ).toMatchObject({ pathMismatch: true });
  });

  it("uses this server's endpoint for a public server", () => {
    expect(resolveWebhookUrl({ publicUrl: "https://callog.acme.dev", relay })).toEqual({
      url: "https://callog.acme.dev/webhooks/github",
      pathMismatch: false,
    });
  });

  it("needs a public relay for a local server", () => {
    const publicUrl = "http://localhost:3000";
    expect(resolveWebhookUrl({ publicUrl, relay })).toEqual({ url: relay, pathMismatch: false });
    expect(resolveWebhookUrl({ publicUrl })).toEqual({ error: "relay" });
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
