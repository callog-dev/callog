import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Enumerations are stored as text with TS-level unions.
export const PROVIDERS = ["slack", "github", "telegram", "email"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const IDENTITY_SOURCES = [
  "sync",
  "verified_domain",
  "commit_heuristic",
  "oauth",
  "deeplink",
  "admin",
] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const CONFIDENCE_LEVELS = ["verified", "high", "suggested"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
/** Confidence an identity needs for mentions, DMs, login and admin rights. */
export const USABLE_CONFIDENCE = ["verified", "high"] as const;

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

/** One tenant = one GitHub App installation on a GitHub org. */
export const tenants = pgTable("tenants", {
  id: id(),
  githubInstallationId: bigint("github_installation_id", { mode: "number" }).unique(),
  /** The org's numeric GitHub id: a reinstall (new installation id) finds the tenant by it. */
  githubOrgId: bigint("github_org_id", { mode: "number" }).unique(),
  githubOrgLogin: text("github_org_login").notNull(),
  configRepo: text("config_repo"),
  status: text("status", { enum: ["active", "inactive"] })
    .notNull()
    .default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Every config repo load; the active config is the latest `valid` one (last-known-good). */
export const configVersions = pgTable(
  "config_versions",
  {
    id: id(),
    tenantId: tenantId(),
    commitSha: text("commit_sha").notNull(),
    status: text("status", { enum: ["valid", "invalid"] }).notNull(),
    config: jsonb("config"),
    errors: jsonb("errors"),
    createdAt: createdAt(),
  },
  (t) => [index("config_versions_tenant_status_idx").on(t.tenantId, t.status, t.createdAt)],
);

export const persons = pgTable(
  "persons",
  {
    id: id(),
    tenantId: tenantId(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("persons_tenant_idx").on(t.tenantId)],
);

/** An account of a person at a provider. */
export const identities = pgTable(
  "identities",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle"),
    source: text("source", { enum: IDENTITY_SOURCES }).notNull(),
    confidence: text("confidence", { enum: CONFIDENCE_LEVELS }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    unique("identities_tenant_provider_external_uq").on(t.tenantId, t.provider, t.externalId),
    index("identities_person_idx").on(t.personId),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** First characters of the key, shown in the UI to tell keys apart. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [unique("api_keys_tenant_name_uq").on(t.tenantId, t.name)],
);

export type NotificationSource =
  | { type: "github_oidc"; repository: string }
  | { type: "api_key"; apiKeyId: string; apiKeyName: string };

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId(),
    routeId: text("route_id").notNull(),
    configVersionId: uuid("config_version_id")
      .notNull()
      .references(() => configVersions.id),
    source: jsonb("source").$type<NotificationSource>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    recipients: text("recipients")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    threadKey: text("thread_key"),
    update: boolean("update").notNull().default(false),
    status: text("status", {
      enum: ["accepted", "processing", "delivered", "partially_failed", "failed"],
    })
      .notNull()
      .default("accepted"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("notifications_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("notifications_tenant_thread_idx").on(t.tenantId, t.threadKey),
  ],
);

export type ProviderMessageRef =
  | { provider: "slack"; channel: string; ts: string }
  | { provider: "telegram"; chatId: string; messageId: number };

export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    tenantId: tenantId(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    destination: text("destination").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    providerMessageRef: jsonb("provider_message_ref").$type<ProviderMessageRef>(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deliveries_notification_idx").on(t.notificationId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

/** Recipients that could not be resolved to an identity of the target provider. */
export const unmappedRecipients = pgTable(
  "unmapped_recipients",
  {
    tenantId: tenantId(),
    ref: text("ref").notNull(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    lastRouteId: text("last_route_id"),
    /** Why a team ref could not be resolved (unknown team, no `members_from`, …). */
    reason: text("reason"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.ref, t.provider] })],
);

/** A tenant's Slack workspace (one per tenant). The bot token is encrypted. */
export const slackConnections = pgTable("slack_connections", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull(),
  teamName: text("team_name").notNull(),
  botUserId: text("bot_user_id").notNull(),
  botTokenEncrypted: text("bot_token_encrypted").notNull(),
  /** App-level token (xapp-…) for Socket Mode: slash commands without a public URL. */
  appTokenEncrypted: text("app_token_encrypted"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A tenant's Telegram bot (one per tenant). Updates are long-polled. */
export const telegramConnections = pgTable("telegram_connections", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Unique: Telegram allows one poller per bot, so a bot serves one tenant. */
  botId: text("bot_id").notNull().unique(),
  botUsername: text("bot_username").notNull(),
  botTokenEncrypted: text("bot_token_encrypted").notNull(),
  /** Last processed `update_id`, so a restart does not replay commands. */
  lastUpdateId: bigint("last_update_id", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Groups and channels the tenant's bot is in. The Bot API cannot list them, so they are
 * remembered when the bot joins or someone sends /chatid, and dropped when it leaves.
 */
export const telegramChats = pgTable(
  "telegram_chats",
  {
    tenantId: tenantId(),
    chatId: text("chat_id").notNull(),
    title: text("title"),
    type: text("type").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.chatId] })],
);

/**
 * One-time tokens that prove "the Slack user who asked" owns the account being linked
 * (Telegram deep-link, GitHub OAuth state). Stored hashed, short-lived.
 */
export const linkTokens = pgTable(
  "link_tokens",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github", "telegram"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /**
     * GitHub account proven by OAuth and waiting for the user's confirmation, and the hash
     * of the nonce cookie of the browser that did the OAuth.
     */
    pendingExternalId: text("pending_external_id"),
    pendingHandle: text("pending_handle"),
    pendingNonceHash: text("pending_nonce_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("link_tokens_expires_idx").on(t.expiresAt)],
);

/** Personal delivery preferences. Absent row = defaults. */
export const personPreferences = pgTable("person_preferences", {
  personId: uuid("person_id")
    .primaryKey()
    .references(() => persons.id, { onDelete: "cascade" }),
  tenantId: tenantId(),
  /** Where personal copies (route `dm: true`) go. */
  dmChannel: text("dm_channel", { enum: ["slack", "telegram"] })
    .notNull()
    .default("slack"),
  /** Routes whose personal copies the person does not want. Channel mentions are unaffected. */
  mutedRoutes: text("muted_routes")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: updatedAt(),
});

/** Web UI sessions. The cookie carries a random token; only its hash is stored. */
export const webSessions = pgTable(
  "web_sessions",
  {
    id: id(),
    tenantId: tenantId(),
    /**
     * Null for a GitHub org owner signed in before their GitHub account is linked to a person:
     * such a session only reaches the admin pages, and only while they own the org.
     */
    personId: uuid("person_id").references(() => persons.id, { onDelete: "cascade" }),
    githubLogin: text("github_login"),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("web_sessions_expires_idx").on(t.expiresAt)],
);

/** The admin role granted in /manage. GitHub org owners are admins without a row. */
export const tenantAdmins = pgTable(
  "tenant_admins",
  {
    tenantId: tenantId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => persons.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.personId] })],
);

/** Who changed what in /manage; today only admin role changes. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: tenantId(),
    /** Null for changes the system made (e.g. a role dropped on deactivation). */
    actorPersonId: uuid("actor_person_id").references(() => persons.id, { onDelete: "set null" }),
    /** An org owner acting without a linked person. */
    actorGithubLogin: text("actor_github_login"),
    action: text("action").notNull(),
    subjectPersonId: uuid("subject_person_id").references(() => persons.id, {
      onDelete: "set null",
    }),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_tenant_idx").on(t.tenantId, t.createdAt)],
);
