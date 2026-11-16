import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { deliveries, tenants, unmappedRecipients } from "../src/db/schema";
import { DeliveryService } from "../src/delivery/delivery.service";
import { PeopleService } from "../src/identity/people.service";
import { ApiKeysService } from "../src/producers/api-keys.service";
import { SlackConnectionsService } from "../src/slack/slack-connections.service";
import type { FakeOidc } from "./setup/fake-oidc";
import { GOOD_SLACK_TOKEN, type FakeSlack } from "./setup/fake-slack";
import { createTestApp, createTenant, activateConfig } from "./setup/test-app";

describe("the built-in direct route (integration)", () => {
  let app: NestFastifyApplication;
  let slack: FakeSlack;
  let oidc: FakeOidc;
  let db: Db;
  let tenantId: string;
  let directKey: string;

  beforeAll(async () => {
    ({ app, slack, oidc } = await createTestApp());
    db = app.get(DB);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.delete(tenants);
    slack.posted = [];
    slack.channels = [{ id: "C0DEPLOY1", name: "deploys" }];
    tenantId = await createTenant(app, 2300);
    await app.get(SlackConnectionsService).connect(tenantId, GOOD_SLACK_TOKEN);
    await app.get(PeopleService).linkAccounts(tenantId, {
      displayName: "bob",
      accounts: [
        { provider: "slack", externalId: "UBOB", source: "sync", confidence: "verified" },
        {
          provider: "github",
          externalId: "2",
          handle: "bob",
          source: "oauth",
          confidence: "verified",
        },
      ],
    });
    // No routes at all: the built-in one needs none.
    await activateConfig(app, tenantId, {
      "places.yaml": 'places: { deploys: { slack: "#deploys" } }',
    });
    ({ key: directKey } = await app.get(ApiKeysService).create(tenantId, "ops", { direct: true }));
  });

  const notify = (body: unknown, token = directKey) =>
    app.inject({
      method: "POST",
      url: "/v1/notify",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });

  it("sends plain text to a person and to a place", async () => {
    const res = await notify({
      route: "direct",
      data: { text: "Backup failed: <disk full>" },
      recipients: ["github:bob", "place:deploys"],
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().notification_id as string;

    expect(await app.get(DeliveryService).deliver(id, { attempt: 1, maxAttempts: 8 })).toBe(
      "delivered",
    );

    const rows = await db.select().from(deliveries);
    expect(rows.map((r) => r.destination).sort()).toEqual(["#deploys", "dm:UBOB"]);
    expect(new Set(slack.posted.map((p) => p.message.text))).toEqual(
      new Set(["Backup failed: &lt;disk full&gt;"]),
    );
  });

  it("records the people it could not reach", async () => {
    const res = await notify({
      route: "direct",
      data: { text: "hi" },
      recipients: ["github:ghost", "github:bob"],
    });
    await app
      .get(DeliveryService)
      .deliver(res.json().notification_id as string, { attempt: 1, maxAttempts: 8 });

    const unmapped = await db.select().from(unmappedRecipients);
    expect(new Set(unmapped.map((u) => u.ref))).toEqual(new Set(["github:ghost"]));
    expect(unmapped.every((u) => u.lastRouteId === "direct")).toBe(true);
  });

  it("is only for API keys that were given it", async () => {
    const body = { route: "direct", data: { text: "hi" }, recipients: ["github:bob"] };
    const { key: plain } = await app.get(ApiKeysService).create(tenantId, "ci");

    expect((await notify(body, plain)).statusCode).toBe(403);
    expect((await notify(body, await oidc.sign("acme/e2e"))).statusCode).toBe(403);
  });

  it("needs a text and someone to send it to", async () => {
    expect(
      (await notify({ route: "direct", data: {}, recipients: ["github:bob"] })).statusCode,
    ).toBe(422);
    expect((await notify({ route: "direct", data: { text: "hi" } })).statusCode).toBe(422);
  });
});
