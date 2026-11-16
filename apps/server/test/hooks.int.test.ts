import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { notifications, tenants } from "../src/db/schema";
import { HooksService } from "../src/producers/hooks.service";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

const CONFIG = {
  "places.yaml": 'places: { alerts: { slack: "#alerts" } }',
  "routes/alert.yaml": `
id: alert
allowed_sources: { api_keys: [ci] }
default_place: alerts
recipients:
  - "github:{{ data.commit.author }}"
  - "{% for name in data.places %}place:{{ name }} {% endfor %}"
  - team:sre
template: [{ text: "{{ data.title }}" }]`,
};

describe("inbound webhooks (integration)", () => {
  let app: NestFastifyApplication;
  let db: Db;
  let hooks: HooksService;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    db = app.get(DB);
    hooks = app.get(HooksService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    tenantId = await createTenant(app, 2100);
    await activateConfig(app, tenantId, CONFIG);
    ({ token } = await hooks.create(tenantId, "grafana", "alert"));
  });

  const post = (payload: string, path = token) =>
    app.inject({
      method: "POST",
      url: `/v1/hooks/${path}`,
      headers: { "content-type": "application/json" },
      payload,
    });
  const stored = async () => (await db.select().from(notifications))[0]!;

  it("accepts any JSON object for the hook's route, without credentials in headers", async () => {
    const res = await post(JSON.stringify({ title: "High CPU", status: "firing" }));

    expect(res.statusCode).toBe(202);
    const notification = await stored();
    expect(res.json()).toEqual({ notification_id: notification.id, status: "accepted" });
    expect(notification).toMatchObject({
      tenantId,
      routeId: "alert",
      data: { title: "High CPU", status: "firing" },
      source: { type: "hook", hookName: "grafana", routeId: "alert" },
    });
  });

  it("takes the recipients from the body, as the route tells", async () => {
    await post(
      JSON.stringify({ title: "x", commit: { author: "octocat" }, places: ["alerts", "nowhere"] }),
    );

    // The unknown place is left out: the sender cannot fix what the route asks for.
    expect((await stored()).recipients).toEqual(["github:octocat", "place:alerts", "team:sre"]);
  });

  it("names nobody for what the body does not have", async () => {
    await post(JSON.stringify({ title: "x" }));

    expect((await stored()).recipients).toEqual(["team:sre"]);
  });

  it("takes the token from the Authorization header, keeping it out of the URL", async () => {
    const inject = (authorization?: string) =>
      app.inject({
        method: "POST",
        url: "/v1/hooks",
        headers: { "content-type": "application/json", ...(authorization && { authorization }) },
        payload: JSON.stringify({ title: "High CPU" }),
      });

    expect((await inject(`Bearer ${token}`)).statusCode).toBe(202);
    expect((await stored()).source).toMatchObject({ type: "hook", hookName: "grafana" });
    expect((await inject()).statusCode).toBe(401);
    expect((await inject("Bearer hk_unknown")).statusCode).toBe(401);
  });

  it("401 for an unknown or revoked token", async () => {
    expect((await post("{}", "hk_unknown")).statusCode).toBe(401);
    await hooks.revoke(tenantId, "grafana");
    expect((await post("{}")).statusCode).toBe(401);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it("422 for a body that is not a JSON object", async () => {
    expect((await post("[1, 2]")).statusCode).toBe(422);
  });

  it("413 for bodies over 64 KB", async () => {
    expect((await post(JSON.stringify({ title: "x".repeat(70_000) }))).statusCode).toBe(413);
  });
});
