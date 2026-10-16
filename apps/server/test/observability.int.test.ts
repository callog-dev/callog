import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DB } from "../src/db/db";
import { QueueService } from "../src/queue/queue.service";
import { tenants } from "../src/db/schema";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import { GOOD_SLACK_TOKEN } from "./setup/fake-slack";
import { createTestApp, eventually, activateConfig } from "./setup/test-app";

describe("observability (integration)", () => {
  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it("exposes delivery, API and queue metrics", async () => {
    const { app, adminRequest } = await createTestApp({ role: "all" });
    try {
      const db = app.get(DB);
      await db.delete(tenants);
      const [tenant] = await db
        .insert(tenants)
        .values({ githubInstallationId: 900, githubOrgLogin: "acme" })
        .returning();
      await app.get(SlackConnectionsService).connect(tenant!.id, GOOD_SLACK_TOKEN);
      await activateConfig(app, tenant!.id, {
        "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#alerts" }]
template: [{ text: "{{ recipients | mention }}" }]`,
      });
      const { key } = (
        await adminRequest("POST", `/admin/tenants/${tenant!.id}/api-keys`, { name: "ci" })
      ).json();

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/notify",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        payload: JSON.stringify({ route: "r", recipients: ["github:ghost"] }),
      });
      expect(accepted.statusCode, accepted.body).toBe(202);

      const metrics = await eventually(async () => {
        const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
        return text.includes('callog_deliveries_total{provider="slack",status="sent"} 1')
          ? text
          : undefined;
      });
      expect(metrics).toContain('callog_notifications_received_total{route="r"} 1');
      expect(metrics).toContain('callog_unmapped_recipients_total{provider="slack"} 1');
      expect(metrics).toContain('callog_delivery_latency_seconds_count{provider="slack"} 1');
      expect(metrics).toMatch(/callog_queue_jobs\{state="ready"\} \d+/);
      expect(metrics).toContain("process_cpu_user_seconds_total");

      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("counts jobs waiting for their run time (backoff) apart from ready ones", async () => {
    const { app } = await createTestApp();
    try {
      const gauge = async (state: string) => {
        const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
        return Number(
          new RegExp(`callog_queue_jobs\\{state="${state}"\\} (\\d+)`).exec(metrics)?.[1],
        );
      };
      await app.get(DB).execute(sql`delete from graphile_worker._private_jobs`);
      await app
        .get(QueueService)
        .enqueue("test.later", {}, { runAt: new Date(Date.now() + 3_600_000) });
      // Only the delayed job is in the future (startup may still enqueue due config loads).
      expect(await gauge("scheduled")).toBe(1);
    } finally {
      await app.get(DB).execute(sql`delete from graphile_worker._private_jobs`);
      await app.close();
    }
  });

  it("protects /metrics with METRICS_TOKEN when set", async () => {
    process.env.METRICS_TOKEN = "metrics-token-0123456789";
    const { app } = await createTestApp();
    try {
      expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
      const ok = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer metrics-token-0123456789" },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
