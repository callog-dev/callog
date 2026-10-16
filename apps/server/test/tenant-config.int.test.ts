import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { configVersions, tenants } from "../src/db/schema";
import { ConfigLoader } from "../src/tenant-config/config-loader";
import { TenantConfigService } from "../src/tenant-config/tenant-config.service";
import { TenantsService, type Tenant } from "../src/tenants/tenants.service";
import type { FakeGithub } from "./setup/fake-github";
import { ADMIN_TOKEN, createTestApp, eventually } from "./setup/test-app";

const ORG = "acme";
const CONFIG_REPO = `${ORG}/notify-config`;
const INSTALLATION = 501;

const route = (id: string, destination = '{ slack: "#alerts" }') => `
id: ${id}
allowed_sources: { github_repos: [${ORG}/e2e] }
destinations: [${destination}]
template: [{ text: "hi {{ data.x }}" }]
`;

describe("tenant config loading (integration)", () => {
  let app: NestFastifyApplication;
  let github: FakeGithub;
  let sendWebhook: Awaited<ReturnType<typeof createTestApp>>["sendWebhook"];
  let db: Db;
  let loader: ConfigLoader;
  let configs: TenantConfigService;
  let tenant: Tenant;

  beforeAll(async () => {
    ({ app, github, sendWebhook } = await createTestApp({ role: "all" }));
    db = app.get(DB);
    loader = app.get(ConfigLoader);
    configs = app.get(TenantConfigService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    github.repos.clear();
    const [created] = await db
      .insert(tenants)
      .values({ githubInstallationId: INSTALLATION, githubOrgLogin: ORG })
      .returning();
    tenant = created!;
  });

  const versions = () =>
    db
      .select()
      .from(configVersions)
      .where(eq(configVersions.tenantId, tenant.id))
      .orderBy(desc(configVersions.createdAt));

  it("loads a valid config and makes it active", async () => {
    const sha = github.push(CONFIG_REPO, { "routes/a.yaml": route("a"), "README.md": "# docs" });

    expect(await loader.load(tenant.id)).toMatchObject({ status: "valid", commitSha: sha });

    const active = await configs.getActive(tenant.id);
    expect(active?.commitSha).toBe(sha);
    expect(Object.keys(active!.config.routes)).toEqual(["a"]);
    // Non-YAML files are not downloaded.
    expect(github.requests.filter((r) => r.includes("blobs"))).toHaveLength(1);
  });

  it("never activates an older commit when loads overlap (admin reload vs push job)", async () => {
    const first = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
    github.requests = [];
    let release!: () => void;
    github.treeGate = new Promise((r) => (release = r));
    const slow = loader.load(tenant.id); // has read HEAD = first, now waits for the tree
    await eventually(async () =>
      github.requests.includes("GET /repos/{owner}/{repo}/git/trees/{tree_sha}") ? true : undefined,
    );
    const second = github.push(CONFIG_REPO, {
      "routes/a.yaml": route("a"),
      "routes/b.yaml": route("b"),
    });
    const fast = loader.load(tenant.id);
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([slow, fast]);

    expect(first).not.toBe(second);
    expect((await configs.getActive(tenant.id))?.commitSha).toBe(second);
  });

  it("records nothing when an activation listener fails, so the retry activates it", async () => {
    const sha = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
    let failures = 1;
    configs.onActivated(async () => {
      if (failures-- > 0) throw new Error("queue unavailable");
    });

    await expect(loader.load(tenant.id)).rejects.toThrow("queue unavailable");
    expect(await versions()).toEqual([]);
    expect(await loader.load(tenant.id)).toMatchObject({ status: "valid", commitSha: sha });
  });

  it("accepts a commit an older server version rejected once it is loaded again", async () => {
    const sha = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
    await configs.recordInvalid(tenant.id, sha, [{ file: "x", path: [], message: "old" }], []);

    expect(await loader.load(tenant.id)).toMatchObject({ status: "valid", commitSha: sha });
    // A commit that is still invalid is not recorded again.
    const bad = github.push(CONFIG_REPO, { "routes/a.yaml": route("a", "{ team: nope }") });
    await loader.load(tenant.id);
    expect(await loader.load(tenant.id)).toMatchObject({ status: "unchanged", commitSha: bad });
    expect((await versions()).map((v) => v.status)).toEqual(["invalid", "valid", "invalid"]);
  });

  it("keeps the last valid config when a broken one is pushed", async () => {
    const good = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
    await loader.load(tenant.id);
    const bad = github.push(CONFIG_REPO, { "routes/a.yaml": route("a", "{ team: nope }") });

    expect(await loader.load(tenant.id)).toMatchObject({ status: "invalid", commitSha: bad });

    expect((await configs.getActive(tenant.id))?.commitSha).toBe(good);
    const [latest] = await versions();
    expect(latest).toMatchObject({ status: "invalid", commitSha: bad });
    expect(JSON.stringify(latest!.errors)).toContain('unknown team \\"nope\\"');
  });

  it("does not create a version when HEAD has not changed", async () => {
    github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
    await loader.load(tenant.id);
    expect(await loader.load(tenant.id)).toMatchObject({ status: "unchanged" });
    expect(await versions()).toHaveLength(1);
  });

  it("skips tenants without a config repo", async () => {
    expect(await loader.load(tenant.id)).toEqual({
      status: "skipped",
      reason: `config repo ${CONFIG_REPO} is missing or empty`,
    });
    expect(await versions()).toHaveLength(0);
  });

  it("honours an explicit config_repo", async () => {
    await db
      .update(tenants)
      .set({ configRepo: "acme/platform-notify" })
      .where(eq(tenants.id, tenant.id));
    github.push("acme/platform-notify", { "routes/b.yaml": route("b") });
    expect(await loader.load(tenant.id)).toMatchObject({ status: "valid" });
  });

  describe("triggers", () => {
    const push = (repo: string, ref = "refs/heads/main") => ({
      ref,
      installation: { id: INSTALLATION },
      repository: { full_name: repo, default_branch: "main" },
    });

    it("reloads on push to the config repo default branch", async () => {
      const sha = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
      const res = await sendWebhook("push", push(CONFIG_REPO));
      expect(res.statusCode).toBe(200);

      const active = await eventually(() => configs.getActive(tenant.id));
      expect(active.commitSha).toBe(sha);
    });

    it("ignores pushes to other repos and branches", async () => {
      github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
      await sendWebhook("push", push(`${ORG}/e2e`));
      await sendWebhook("push", push(CONFIG_REPO, "refs/heads/feature"));
      await new Promise((r) => setTimeout(r, 1000));
      expect(await versions()).toHaveLength(0);
    });

    it("loads the config when a tenant is activated", async () => {
      await db.delete(tenants);
      const sha = github.push("fresh-org/notify-config", { "routes/a.yaml": route("a") });
      const created = await app
        .get(TenantsService)
        .activateInstallation({ installationId: 777, orgId: 7770, orgLogin: "fresh-org" });

      const active = await eventually(() => configs.getActive(created.id));
      expect(active.commitSha).toBe(sha);
    });
  });

  describe("admin endpoints", () => {
    const call = (method: "GET" | "POST", path: string, token?: string) =>
      app.inject({
        method,
        url: `/admin/tenants/${tenant.id}/config${path}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    it("requires the admin token", async () => {
      expect((await call("POST", "/reload")).statusCode).toBe(401);
      expect((await call("POST", "/reload", "wrong-token-wrong-token-xx")).statusCode).toBe(401);
    });

    it("reloads and reports status", async () => {
      const sha = github.push(CONFIG_REPO, { "routes/a.yaml": route("a") });
      const reload = await call("POST", "/reload", ADMIN_TOKEN);
      expect(reload.statusCode).toBe(201);
      expect(reload.json()).toMatchObject({ status: "valid", commitSha: sha });

      const status = await call("GET", "", ADMIN_TOKEN);
      expect(status.json()).toMatchObject({
        active: { commitSha: sha, routes: ["a"] },
        latest: { commitSha: sha, status: "valid" },
      });
    });
  });
});
