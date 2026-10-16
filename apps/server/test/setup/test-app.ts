import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { parseConfigTree, type ConfigTree } from "@callog/config-schema";
import { Test } from "@nestjs/testing";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { AppModule } from "../../src/app.module";
import { GithubAppService } from "../../src/github/github-app.service";
import { signWebhookBody } from "../../src/github/webhook-signature";
import { GITHUB_OAUTH_CLIENT, type GithubOAuthClient } from "../../src/identity/github-oauth";
import { DESTINATION_RATE_LIMITER, DestinationRateLimiter } from "../../src/delivery/rate-limiter";
import { OIDC_KEY_RESOLVER } from "../../src/producers/github-oidc";
import { SLACK_API_FACTORY } from "../../src/slack/slack-api";
import { SLACK_SOCKET_FACTORY } from "../../src/slack/slack-socket";
import { TELEGRAM_API_FACTORY } from "../../src/telegram/telegram-api";
import { FakeGithub } from "./fake-github";
import { FakeOidc } from "./fake-oidc";
import { FakeSlack } from "./fake-slack";
import { FakeTelegram } from "./fake-telegram";
import { createPool, DB, type Db } from "../../src/db/db";
import { tenants } from "../../src/db/schema";
import { TenantConfigService } from "../../src/tenant-config/tenant-config.service";
import { TEST_DATABASE_URL } from "./test-env";

export const WEBHOOK_SECRET = "test-webhook-secret";
export const ADMIN_TOKEN = "test-admin-token-0123456789";

/** Full app against the test database with GitHub replaced by an in-memory fake. */
export async function createTestApp(options: { role?: "api" | "worker" | "all" } = {}) {
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    ROLE: options.role ?? "api",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString(),
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_TOKEN,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    GITHUB_APP_CLIENT_ID: "Iv-test-client",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
    PUBLIC_URL: "https://notify.test",
  });
  if ((options.role ?? "api") !== "api") {
    // Other test files leave jobs behind; a fresh worker must not spend its time on them.
    const pool = createPool(TEST_DATABASE_URL);
    await pool.query("delete from graphile_worker._private_jobs").finally(() => pool.end());
  }
  const github = new FakeGithub();
  const slack = new FakeSlack();
  const oidc = await FakeOidc.create();
  const telegram = new FakeTelegram();
  /** OAuth code → GitHub user that approved it. */
  const githubOAuthUsers = new Map<string, { id: number; login: string }>();
  const githubOAuth: GithubOAuthClient = {
    userFromCode: async (code) => {
      const user = githubOAuthUsers.get(code);
      if (!user) throw new Error("bad_verification_code");
      return user;
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GithubAppService)
    .useValue(github)
    .overrideProvider(SLACK_API_FACTORY)
    .useValue(slack.factory)
    .overrideProvider(SLACK_SOCKET_FACTORY)
    .useValue(slack.socketFactory)
    .overrideProvider(OIDC_KEY_RESOLVER)
    .useValue(oidc.keys)
    .overrideProvider(TELEGRAM_API_FACTORY)
    .useValue(telegram.factory)
    .overrideProvider(GITHUB_OAUTH_CLIENT)
    .useValue(githubOAuth)
    // No real spacing between messages in tests.
    .overrideProvider(DESTINATION_RATE_LIMITER)
    .useValue(new DestinationRateLimiter({ default: 0, telegramGroup: 0 }))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    rawBody: true,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const sendWebhook = (event: string, payload: unknown, secret = WEBHOOK_SECRET) => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": signWebhookBody(secret, body),
      },
      payload: body,
    });
  };

  const adminRequest = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  return { app, github, slack, telegram, oidc, githubOAuthUsers, sendWebhook, adminRequest };
}

export async function eventually<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A tenant for a GitHub org; returns its id. */
export async function createTenant(
  app: INestApplication,
  githubInstallationId: number,
  githubOrgLogin = "acme",
  githubOrgId?: number,
): Promise<string> {
  const [tenant] = await app
    .get<Db>(DB)
    .insert(tenants)
    .values({ githubInstallationId, githubOrgLogin, githubOrgId })
    .returning();
  return tenant!.id;
}

/** Makes a config tree the tenant's active config; fixtures must be valid. */
export async function activateConfig(
  app: INestApplication,
  tenantId: string,
  tree: ConfigTree,
  commitSha = "sha",
) {
  const parsed = parseConfigTree(tree);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return app.get(TenantConfigService).recordValid(tenantId, commitSha, parsed.config, []);
}
