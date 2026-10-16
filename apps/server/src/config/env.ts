import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  /**
   * Direct connection for the queue worker when DATABASE_URL goes through a transaction-mode
   * pooler (PgBouncer, Supabase/Neon poolers): LISTEN/NOTIFY needs a real session (docs/setup.md).
   */
  DATABASE_URL_DIRECT: z.url().optional(),
  /** CA certificate (PEM) for a Postgres with a private CA; alternative: DATABASE_SSL_CA_PATH. */
  DATABASE_SSL_CA: z.string().min(1).optional(),
  DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Which parts of the server this process runs. */
  ROLE: z.enum(["api", "worker", "all"]).default("all"),
  // GitHub App. Optional so the server can run without it in development;
  // GitHub features are disabled until all three are set.
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  /** PEM contents; alternative to GITHUB_APP_PRIVATE_KEY_PATH (handy in containers). */
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** GitHub App OAuth (user-to-server): `/notify link github` and web login. */
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  /** Base URL users' browsers reach the server at (OAuth callbacks), e.g. https://notify.acme.dev */
  PUBLIC_URL: z.url().optional(),
  /** 32 bytes, base64 (`openssl rand -base64 32`). Encrypts provider secrets at rest. */
  ENCRYPTION_KEY: z.string().min(1).optional(),
  /**
   * Bearer token for operator endpoints (`/admin/*`).
   * Admin endpoints are disabled when unset.
   */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** `aud` the GitHub Action requests for its OIDC token. */
  OIDC_AUDIENCE: z.string().min(1).default("callog"),
  /** `json` for log collectors (default in containers), `pretty` for local development. */
  LOG_FORMAT: z.enum(["json", "pretty"]).default("pretty"),
  LOG_LEVEL: z.enum(["error", "warn", "log", "debug", "verbose"]).default("log"),
  /** When set, `GET /metrics` requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol("ENV");

/**
 * An empty variable means "not set": `.env` files and compose pass `KEY=` lines through as
 * empty strings, and an optional setting left blank must not fail validation.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const set = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const result = envSchema.safeParse(set);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
