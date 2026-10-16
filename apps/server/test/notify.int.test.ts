import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { notifications, tenants } from "../src/db/schema";
import type { FakeOidc } from "./setup/fake-oidc";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const ROUTE = `
id: e2e-failed
allowed_sources: { github_repos: [acme/e2e], api_keys: [billing] }
destinations: [{ slack: "#alerts" }]
schema:
  type: object
  required: [branch, run_url]
  properties:
    branch: { type: string }
    failed: { type: integer }
    run_url: { type: string, format: uri }
template: [{ text: "{{ data.branch }}" }]`;

const BODY = {
  route: "e2e-failed",
  data: { branch: "main", failed: 3, run_url: "https://github.com/acme/e2e/actions/runs/1" },
  recipients: ["github:octocat", "team:frontend"],
};

describe("POST /v1/notify (integration)", () => {
  let app: NestFastifyApplication;
  let oidc: FakeOidc;
  let db: Db;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    ({ app, oidc } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    await db.execute(sql`delete from graphile_worker._private_jobs`);
    tenantId = await createTenant(app, 700);
    await activateConfig(app, tenantId, { "routes/e2e-failed.yaml": ROUTE });
    token = await oidc.sign("acme/e2e");
  });

  const notify = (body: unknown, headers: Record<string, string> = {}, auth = token) =>
    app.inject({
      method: "POST",
      url: "/v1/notify",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...headers },
      payload: JSON.stringify(body),
    });

  const jobs = async () =>
    (
      await db.execute<{ task_identifier: string; queue_name: string | null; payload: unknown }>(
        sql`select v.task_identifier, v.queue_name, j.payload
            from graphile_worker.jobs v join graphile_worker._private_jobs j using (id)
            where v.task_identifier = 'notification.deliver'`,
      )
    ).rows;

  it("accepts a valid request: 202, stored notification and a queued delivery job", async () => {
    const res = await notify({ ...BODY, thread_key: "e2e/main/1" });

    expect(res.statusCode).toBe(202);
    const { notification_id: id, status } = res.json();
    expect(status).toBe("accepted");
    const [row] = await db.select().from(notifications);
    expect(row).toMatchObject({
      id,
      tenantId,
      routeId: "e2e-failed",
      source: { type: "github_oidc", repository: "acme/e2e" },
      recipients: ["github:octocat", "team:frontend"],
      threadKey: "e2e/main/1",
      status: "accepted",
    });
    expect(await jobs()).toEqual([
      {
        task_identifier: "notification.deliver",
        queue_name: `thread:${tenantId}:e2e/main/1`,
        payload: { notificationId: id },
      },
    ]);
  });

  it("does not use a queue without thread_key", async () => {
    await notify(BODY);
    expect((await jobs())[0]?.queue_name).toBeNull();
  });

  describe("idempotency", () => {
    it("replays the same notification for the same key and body", async () => {
      const first = await notify(BODY, { "idempotency-key": "run-1" });
      // Same content with keys in another order hashes the same.
      const reordered = { recipients: BODY.recipients, data: BODY.data, route: BODY.route };
      const second = await notify(reordered, { "idempotency-key": "run-1" });

      expect(second.statusCode).toBe(202);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.json().notification_id).toBe(first.json().notification_id);
      expect(await db.select().from(notifications)).toHaveLength(1);
      expect(await jobs()).toHaveLength(1);
    });

    it("returns 409 when the key is reused with a different body", async () => {
      await notify(BODY, { "idempotency-key": "run-1" });
      const res = await notify(
        { ...BODY, data: { ...BODY.data, failed: 4 } },
        { "idempotency-key": "run-1" },
      );
      expect(res.statusCode).toBe(409);
    });

    it("handles concurrent requests with the same key", async () => {
      const [a, b] = await Promise.all([
        notify(BODY, { "idempotency-key": "race" }),
        notify(BODY, { "idempotency-key": "race" }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect(a.json().notification_id).toBe(b.json().notification_id);
      expect(await db.select().from(notifications)).toHaveLength(1);
    });

    it("replays even after the config changed, but not for another producer", async () => {
      const first = await notify(BODY, { "idempotency-key": "run-2" });
      await activateConfig(
        app,
        tenantId,
        { "routes/other.yaml": ROUTE.replace("e2e-failed", "other") },
        "sha2",
      );

      const retry = await notify(BODY, { "idempotency-key": "run-2" });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().notification_id).toBe(first.json().notification_id);

      const stranger = await notify(
        BODY,
        { "idempotency-key": "run-2" },
        await oidc.sign("acme/x"),
      );
      expect(stranger.statusCode).toBe(409);
    });

    it("treats expired keys as new", async () => {
      await notify(BODY, { "idempotency-key": "old" });
      await db.execute(sql`update idempotency_keys set expires_at = now() - interval '1 second'`);
      const res = await notify(
        { ...BODY, data: { ...BODY.data, failed: 9 } },
        { "idempotency-key": "old" },
      );
      expect(res.statusCode).toBe(202);
      expect(await db.select().from(notifications)).toHaveLength(2);
    });
  });

  describe("errors", () => {
    it("401 without valid credentials", async () => {
      expect((await notify(BODY, {}, "ntf_nope")).statusCode).toBe(401);
    });

    it("403 for a producer not allowed on the route", async () => {
      expect((await notify(BODY, {}, await oidc.sign("acme/other"))).statusCode).toBe(403);
    });

    it("404 for an unknown route", async () => {
      expect((await notify({ ...BODY, route: "nope" })).statusCode).toBe(404);
      // Object.prototype keys are slugs too; they must not resolve to inherited members.
      expect((await notify({ ...BODY, route: "constructor" })).statusCode).toBe(404);
    });

    it("413 for bodies over 64 KB", async () => {
      const res = await notify({ ...BODY, data: { ...BODY.data, blob: "x".repeat(70_000) } });
      expect(res.statusCode).toBe(413);
    });

    it("422 with issues for malformed bodies", async () => {
      const res = await notify({ route: "e2e-failed", recipients: ["octocat"], extra: 1 });
      expect(res.statusCode).toBe(422);
      expect(
        res
          .json()
          .issues.map((i: { path: string }) => i.path)
          .sort(),
      ).toEqual(["", "recipients.0"]);
    });

    it("422 when data does not match the route schema", async () => {
      const res = await notify({ ...BODY, data: { branch: 1, run_url: "not a url" } });
      expect(res.statusCode).toBe(422);
      expect(res.json().issues).toEqual(
        expect.arrayContaining([
          { path: "data.branch", message: "must be string" },
          { path: "data.run_url", message: 'must match format "uri"' },
        ]),
      );
    });

    it("422 for update without thread_key", async () => {
      expect((await notify({ ...BODY, update: true })).statusCode).toBe(422);
    });

    it("400 for an oversized Idempotency-Key", async () => {
      expect((await notify(BODY, { "idempotency-key": "k".repeat(201) })).statusCode).toBe(400);
    });

    it("503 when the organization has no valid config", async () => {
      await db.execute(sql`delete from config_versions`);
      expect((await notify(BODY)).statusCode).toBe(503);
    });
  });

  describe("GET /v1/notifications/:id", () => {
    const get = (id: string, auth = token) =>
      app.inject({
        method: "GET",
        url: `/v1/notifications/${id}`,
        headers: { authorization: `Bearer ${auth}` },
      });

    it("returns the notification status to the same organization", async () => {
      const id = (await notify(BODY)).json().notification_id;
      const res = await get(id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        route: "e2e-failed",
        status: "accepted",
        deliveries: [],
      });
    });

    it("hides notifications of other organizations", async () => {
      const id = (await notify(BODY)).json().notification_id;
      const [other] = await db
        .insert(tenants)
        .values({ githubInstallationId: 701, githubOrgLogin: "other" })
        .returning();
      expect(other).toBeDefined();
      expect((await get(id, await oidc.sign("other/repo"))).statusCode).toBe(404);
    });
  });
});
