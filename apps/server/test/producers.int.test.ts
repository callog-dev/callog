import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { apiKeys, tenants } from "../src/db/schema";
import type { FakeOidc } from "./setup/fake-oidc";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const ROUTE = `
id: deploys
allowed_sources:
  github_repos: [Acme/E2E]
  api_keys: [billing]
destinations: [{ slack: "#x" }]
template: [{ text: hi }]`;

describe("producer authentication (integration)", () => {
  let app: NestFastifyApplication;
  let oidc: FakeOidc;
  let admin: Awaited<ReturnType<typeof createTestApp>>["adminRequest"];
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    ({ app, oidc, adminRequest: admin } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    tenantId = await createTenant(app, 600);
    await activateConfig(app, tenantId, { "routes/deploys.yaml": ROUTE });
  });

  const whoami = (token?: string, route?: string) =>
    app.inject({
      method: "GET",
      url: `/v1/whoami${route ? `?route=${route}` : ""}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  const createKey = async (name: string) => {
    const res = await admin("POST", `/admin/tenants/${tenantId}/api-keys`, { name });
    expect(res.statusCode).toBe(201);
    return res.json() as { key: string; prefix: string };
  };

  describe("GitHub Actions OIDC", () => {
    it("accepts a token from an allowed repository (case-insensitive)", async () => {
      const res = await whoami(await oidc.sign("acme/e2e"), "deploys");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        producer: "GitHub Actions in acme/e2e",
        source: { type: "github_oidc", repository: "acme/e2e" },
        route: "deploys",
      });
    });

    it("returns 403 for a repository of the org that is not allowed on the route", async () => {
      const token = await oidc.sign("acme/other");
      expect((await whoami(token)).statusCode).toBe(200);
      const res = await whoami(token, "deploys");
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("acme/other");
    });

    it("finds the tenant by the org's id, not by a login another org may reuse", async () => {
      // The org of this tenant was renamed away from "acme"; another org took the login.
      await db.update(tenants).set({ githubOrgId: 1 }).where(eq(tenants.id, tenantId));
      await createTenant(app, 601, "acme", 2);

      const impostor = await oidc.sign("acme/e2e", { ownerId: 2 });
      expect((await whoami(impostor, "deploys")).statusCode).toBe(404); // its own empty tenant
      const owner = await oidc.sign("acme/e2e", { ownerId: 1 });
      expect((await whoami(owner, "deploys")).statusCode).toBe(200);
    });

    it("returns 401 for an org without an installation", async () => {
      const res = await whoami(await oidc.sign("evil/e2e"), "deploys");
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ["wrong audience", { audience: "someone-else" }],
      ["wrong issuer", { issuer: "https://evil.example" }],
      ["expired", { expiresIn: "-1m" }],
    ])("returns 401 for a token with %s", async (_, overrides) => {
      expect((await whoami(await oidc.sign("acme/e2e", overrides))).statusCode).toBe(401);
    });

    it("returns 401 for a token signed by another key", async () => {
      const { privateKey } = await generateKeyPair("RS256");
      expect((await whoami(await oidc.sign("acme/e2e", { key: privateKey }))).statusCode).toBe(401);
    });
  });

  describe("API keys", () => {
    it("creates a key once, stores only its hash and authenticates with it", async () => {
      const { key, prefix } = await createKey("billing");
      expect(key).toMatch(/^ntf_/);
      expect(key.startsWith(prefix)).toBe(true);
      const [row] = await db.select().from(apiKeys);
      expect(row!.keyHash).not.toContain(key);

      const res = await whoami(key, "deploys");
      expect(res.statusCode).toBe(200);
      expect(res.json().producer).toBe('API key "billing"');

      const list = await admin("GET", `/admin/tenants/${tenantId}/api-keys`);
      expect(list.json()[0]).toMatchObject({ name: "billing", prefix });
      expect(list.json()[0].lastUsedAt).not.toBeNull();
      expect(JSON.stringify(list.json())).not.toContain(key);
    });

    it("rejects duplicate names", async () => {
      await createKey("billing");
      const res = await admin("POST", `/admin/tenants/${tenantId}/api-keys`, { name: "billing" });
      expect(res.statusCode).toBe(409);
    });

    it("returns 403 for a key not allowed on the route", async () => {
      const { key } = await createKey("search");
      expect((await whoami(key, "deploys")).statusCode).toBe(403);
    });

    it("stops accepting a revoked key", async () => {
      const { key } = await createKey("billing");
      const res = await admin("DELETE", `/admin/tenants/${tenantId}/api-keys/billing`);
      expect(res.statusCode).toBe(204);
      expect((await whoami(key)).statusCode).toBe(401);
    });

    it("rejects unknown keys and missing credentials", async () => {
      expect((await whoami("ntf_not-a-real-key")).statusCode).toBe(401);
      expect((await whoami()).statusCode).toBe(401);
    });
  });

  it("returns 404 for unknown routes", async () => {
    expect((await whoami(await oidc.sign("acme/e2e"), "nope")).statusCode).toBe(404);
  });
});
