import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreatedGithubApp } from "../src/setup/github-app-manifest";
import { createTestApp } from "./setup/test-app";

const CREATED: CreatedGithubApp = {
  id: 77,
  slug: "callog-acme",
  html_url: "https://github.com/apps/callog-acme",
  owner: { login: "acme" },
  pem: "-----BEGIN RSA PRIVATE KEY-----\nAAA\nBBB\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "whsec-1",
  client_id: "Iv1.created",
  client_secret: "cs-1",
};

const RELAY = "https://smee.io/abc123";

const decode = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function stateCookie(setCookie: string | string[] | undefined): string {
  const header = [setCookie ?? []].flat().find((c) => c.startsWith("callog_setup_state="));
  if (!header) throw new Error("no state cookie");
  return header.split(";")[0]!;
}

describe("GitHub App setup without an App (integration)", () => {
  let app: NestFastifyApplication;
  let createdApps: Map<string, CreatedGithubApp>;

  beforeAll(async () => {
    const t = await createTestApp({ githubApp: false });
    app = t.app as NestFastifyApplication;
    createdApps = t.createdApps;
  });
  afterAll(() => app.close());

  it("sends sign-in to the setup page", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/github/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/setup/github-app");
  });

  it("asks for the organization", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/github-app" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="org"');
    // GitHub cannot deliver webhooks to a .test host: a relay is needed.
    expect(res.body).toContain('name="webhook"');
  });

  it("posts a manifest for this server to the org's App registration", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/setup/github-app/new?org=acme&webhook=${RELAY}`,
    });
    expect(res.statusCode).toBe(200);
    const state = stateCookie(res.headers["set-cookie"]).split("=")[1];
    expect(res.body).toContain(
      `action="https://github.com/organizations/acme/settings/apps/new?state=${state}"`,
    );
    const manifest = JSON.parse(decode(/name="manifest" value="([^"]*)"/.exec(res.body)![1]!));
    expect(manifest).toMatchObject({
      name: "Callog acme",
      hook_attributes: { url: RELAY },
      redirect_url: "https://notify.test/setup/github-app/callback",
      callback_urls: ["https://notify.test/oauth/github/callback"],
    });
  });

  it("requires a public relay for a local server", async () => {
    for (const webhook of ["", "http://smee.io/x", "https://localhost/x"]) {
      const res = await app.inject({
        method: "GET",
        url: `/setup/github-app/new?org=acme&webhook=${encodeURIComponent(webhook)}`,
      });
      expect(res.body).toContain("must be a public https:// address");
    }
  });

  it("rejects an organization name that would break the URL", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/github-app/new?org=acme/x" });
    expect(res.body).toContain("not a GitHub organization name");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("shows the created App's credentials once, as .env lines", async () => {
    const start = await app.inject({
      method: "GET",
      url: `/setup/github-app/new?org=acme&webhook=${RELAY}`,
    });
    const cookie = stateCookie(start.headers["set-cookie"]);
    createdApps.set("code-1", CREATED);

    const res = await app.inject({
      method: "GET",
      url: `/setup/github-app/callback?code=code-1&state=${cookie.split("=")[1]}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const block = decode(/<pre>([^<]*)<\/pre>/.exec(res.body)![1]!);
    expect(parseEnv(block)).toEqual({
      GITHUB_APP_ID: "77",
      GITHUB_APP_PRIVATE_KEY: CREATED.pem,
      GITHUB_WEBHOOK_SECRET: "whsec-1",
      GITHUB_APP_CLIENT_ID: "Iv1.created",
      GITHUB_APP_CLIENT_SECRET: "cs-1",
    });
    expect(res.body).toContain('href="https://github.com/apps/callog-acme/installations/new"');
  });

  it("does not exchange a code for a browser that did not start the flow", async () => {
    createdApps.set("code-2", CREATED);
    const res = await app.inject({
      method: "GET",
      url: "/setup/github-app/callback?code=code-2&state=forged",
    });
    expect(res.body).toContain("outside the setup flow");
    expect(res.body).not.toContain("whsec-1");
  });

  it("explains an expired code", async () => {
    const start = await app.inject({
      method: "GET",
      url: `/setup/github-app/new?org=acme&webhook=${RELAY}`,
    });
    const cookie = stateCookie(start.headers["set-cookie"]);
    const res = await app.inject({
      method: "GET",
      url: `/setup/github-app/callback?code=unknown&state=${cookie.split("=")[1]}`,
      headers: { cookie },
    });
    expect(res.body).toContain("expired or was already used");
  });
});

describe("GitHub App setup with an App configured (integration)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = (await createTestApp()).app as NestFastifyApplication;
  });
  afterAll(() => app.close());

  it("is gone", async () => {
    for (const url of [
      "/setup/github-app",
      "/setup/github-app/new?org=acme",
      "/setup/github-app/callback?code=x&state=y",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});
