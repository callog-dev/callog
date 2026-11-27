export type Provider = "slack" | "github" | "telegram" | "email";
export type DmChannel = "slack" | "telegram";

export interface Identity {
  provider: Provider;
  externalId: string;
  handle: string | null;
  source: string;
  confidence: "verified" | "high" | "suggested";
}

export interface Preferences {
  dmChannel: DmChannel;
  mutedRoutes: string[];
}

/** `person` is null for an org owner signed in before their GitHub account is linked. */
export type Me =
  | {
      person: { id: string; name: string };
      githubLogin: null;
      org: string;
      isAdmin: boolean;
      identities: Identity[];
      preferences: Preferences;
    }
  | {
      person: null;
      githubLogin: string;
      org: string;
      isAdmin: boolean;
      identities: [];
      preferences: null;
    };

export type LinkedMe = Extract<Me, { person: object }>;

export interface RouteSummary {
  id: string;
  description: string | null;
  /** `label` is a human-readable name (Telegram chat title) when the server knows one. */
  destinations: {
    provider: "slack" | "telegram";
    destination: string;
    label?: string;
    /** Posted to only when a notification reaches nobody else. */
    fallback?: boolean;
  }[];
  dm: boolean;
  /** People cannot mute it. */
  mandatory: boolean;
  mentions: "recipients" | "none";
  /** Seconds a group of repeats stays open, when the route groups them. */
  groupWindow: number | null;
  /** The route names recipients itself, from the notification's data. */
  addsRecipients: boolean;
  allowedSources: { github_repos: string[]; api_keys: string[] };
  dataFields: string[];
  muted: boolean;
  url: string;
}

/** `GET /api/routes/:id`; the extra fields come only for admins. */
export interface RouteDetails extends RouteSummary {
  template?: unknown;
  examples?: { data?: Record<string, unknown>; recipients?: string[] }[];
  schema?: unknown;
}

export interface RoutesResponse {
  configRepo: string;
  commitSha: string | null;
  routes: RouteSummary[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, json.message ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  routes: () => request<RoutesResponse>("GET", "/api/routes"),
  route: (id: string) => request<RouteDetails>("GET", `/api/routes/${encodeURIComponent(id)}`),
  setDmChannel: (channel: DmChannel) =>
    request<Preferences>("PUT", "/api/me/preferences/dm", { channel }),
  mute: (routeId: string) =>
    request<Preferences>("PUT", `/api/me/mutes/${encodeURIComponent(routeId)}`),
  unmute: (routeId: string) =>
    request<Preferences>("DELETE", `/api/me/mutes/${encodeURIComponent(routeId)}`),
  logout: () => request<void>("POST", "/api/auth/logout"),
};

// ---- Admin ----

export type NotificationStatus =
  "accepted" | "processing" | "delivered" | "partially_failed" | "failed" | "cancelled";

export interface DeliverySummary {
  provider: "slack" | "telegram";
  destination: string;
  status: "pending" | "sent" | "failed" | "cancelled";
}

export interface NotificationRow {
  id: string;
  route: string;
  status: NotificationStatus;
  source:
    | { type: "github_oidc"; repository: string }
    | { type: "api_key"; apiKeyName: string }
    | { type: "hook"; hookId: string; hookName: string; routeId: string }
    | { type: "admin_test"; actor: string };
  threadKey: string | null;
  createdAt: string;
  deliveries: DeliverySummary[];
}

/** A room, or someone's direct messages, in one channel. */
export interface TargetRoom {
  provider: "slack" | "telegram";
  kind: "place" | "person";
  destination: string;
  /** A human-readable name (Telegram chat title) when the server knows one. */
  label?: string;
}

/** Where a test of a route is posted, whom a personal copy is for, and where it goes if that fails. */
export interface TestTarget extends TargetRoom {
  for: TracedRecipient[];
  fallbacks: TargetRoom[];
}

/** Someone a trace talks about: the ref, and the person's name when Callog knows them. */
export interface TracedRecipient {
  ref: string;
  name: string;
}

/** Why a recipient got no message of their own, or no mention. */
export interface TraceNote {
  recipient: TracedRecipient;
  note: "muted" | "no_account" | "unknown" | "empty_team" | "not_mentioned";
  channel?: string;
  detail?: string;
}

export interface TracedDelivery extends DeliverySummary {
  id: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  /** The people a personal copy, or the post that replaced it, is for. */
  for: TracedRecipient[];
  /** The delivery that took over when this one could not be delivered. */
  fallbackTo: string | null;
}

/** Who stopped a notification: an admin (`@login` or a name), or its sender. */
export type CancelledBy = { type: "admin"; actor: string } | { type: "sender" };

export interface NotificationDetails extends Omit<NotificationRow, "deliveries"> {
  data: Record<string, unknown>;
  recipients: string[];
  update: boolean;
  /** Set when the route groups repeats: `joined` means this one edited an earlier message. */
  group: { key: string; joined: boolean } | null;
  /** Who stopped it and when; deliveries still pending then were cancelled. */
  cancelled: { at: string; by: CancelledBy } | null;
  notes: TraceNote[];
  deliveries: TracedDelivery[];
}

export interface AdminPerson {
  id: string;
  name: string;
  status: "active" | "inactive";
  identities: (Identity & { id: string })[];
}

export interface PersonOption {
  id: string;
  name: string;
}

export type AdminIdentity = AdminPerson["identities"][number];

export interface SuggestedLink extends AdminIdentity {
  person: PersonOption;
}

export interface PersonDetails extends AdminPerson {
  admin: boolean;
  preferences: Preferences;
  recentNotifications: {
    id: string;
    route: string;
    status: NotificationStatus;
    createdAt: string;
  }[];
}

export interface UnmappedRow {
  ref: string;
  provider: "slack" | "telegram";
  occurrences: number;
  lastRoute: string | null;
  /** Why a team could not be resolved; null for person refs. */
  reason: string | null;
  lastSeenAt: string;
}

export interface TeamInfo {
  slug: string;
  slackChannel: string | null;
  telegramChat: string | null;
  membersFrom: { githubTeam: string | null; slackUsergroup: string | null } | null;
  /** Why the team has no people (no `members_from`, source unavailable). */
  reason: string | null;
  members: {
    ref: string;
    provider: "github" | "slack";
    handle: string;
    person: { id: string; name: string; status: "active" | "inactive" } | null;
  }[];
  total: number;
  linked: number;
}

export interface AdminsInfo {
  owners: { login: string; person: { id: string; name: string } | null }[];
  admins: {
    person: { id: string; name: string; status: "active" | "inactive" };
    grantedBy: string | null;
    grantedAt: string;
  }[];
  audit: {
    id: string;
    action: "admin.granted" | "admin.revoked";
    actor: string | null;
    subject: string | null;
    details: { reason?: string } | null;
    createdAt: string;
  }[];
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  /** May send to the built-in `direct` route: plain text to any person or place. */
  direct: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** An inbound webhook: a secret URL that posts any JSON it receives to one route. */
export interface HookInfo {
  id: string;
  name: string;
  routeId: string;
  prefix: string;
  /** The route left the config, so posts to the hook are refused. */
  routeMissing: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A room with a name: what routes and senders call it, and where it is. */
export interface PlaceInfo {
  name: string;
  channel: "slack" | "telegram";
  room: string;
  /** Routes that deliver here. */
  routes: string[];
  /** Routes that post here when a notification reaches nobody else. */
  defaultFor: string[];
  /** What the last check of the room found wrong; an error stops messages to the place. */
  issue?: { level: "error" | "warning"; message: string };
}

/** What the GitHub App's installation lacks of what the server needs. */
export interface GithubAccessGaps {
  permissions: string[];
  events: string[];
}

export const describeGithubGaps = (gaps: GithubAccessGaps): string =>
  [
    gaps.permissions.length > 0 && `permissions (read): ${gaps.permissions.join(", ")}`,
    gaps.events.length > 0 && `events: ${gaps.events.join(", ")}`,
  ]
    .filter(Boolean)
    .join("; ");

export interface AdminStatus {
  tenantId: string;
  installationId: number | null;
  org: string;
  configRepo: string;
  /** Null when nothing is missing. */
  github: GithubAccessGaps | null;
  config: {
    active: { commitSha: string; routes: number } | null;
    latest: {
      commitSha: string;
      status: "valid" | "invalid";
      createdAt: string;
    } | null;
  };
  slack: { team: string; commands: boolean; lastSyncedAt: string | null } | null;
  telegram: { bot: string } | null;
}

export interface ConfigVersionRow {
  id: string;
  commitSha: string;
  status: "valid" | "invalid";
  createdAt: string;
  errors: number;
  routes: number;
  active: boolean;
}

export interface ConfigVersionDetails extends Omit<ConfigVersionRow, "errors" | "routes"> {
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  routes: string[];
  previousCommitSha: string | null;
}

export type AttentionItem =
  | { kind: "config_rejected"; versionId: string; errors: number }
  | { kind: "no_config" | "slack_missing" }
  | { kind: "failed" | "partially_failed" | "unmapped" | "suggested"; count: number }
  | { kind: "sync_stale"; lastSyncedAt: string | null }
  | ({ kind: "github_access" } & GithubAccessGaps);

export interface Attention {
  items: AttentionItem[];
  counters: { routes: number; people: number; notifications24h: number; delivered24h: number };
}

export interface RetentionReport {
  notifications: number;
  configVersions: number;
  unmappedRecipients: number;
}

export interface MaintenanceStatus {
  sync: { at: string } | null;
  retention: { at: string; details: RetentionReport } | null;
}

export interface ConfigIssue {
  file: string;
  path: (string | number)[];
  message: string;
}

export interface Onboarding {
  steps: {
    githubApp: { done: boolean; org: string; installationId: number | null };
    slack: { done: boolean; team: string | null };
    linkGithub: { done: boolean };
    telegram: { done: boolean; optional: true; bot: string | null };
    config: { done: boolean; repo: string; rejected: boolean; errors: ConfigIssue[] };
    firstNotification: { done: boolean };
    hooks: { done: boolean; optional: true };
  };
  complete: boolean;
}

export interface TelegramChat {
  chatId: string;
  title: string | null;
  type: string;
}

export const adminApi = {
  onboarding: () => request<Onboarding>("GET", "/api/admin/onboarding"),
  connectSlack: (botToken: string, appToken: string) =>
    request<{ team: string }>("PUT", "/api/admin/slack", { botToken, appToken }),
  connectTelegram: (botToken: string) =>
    request<{ bot: string }>("PUT", "/api/admin/telegram", { botToken }),
  telegramChats: () => request<TelegramChat[]>("GET", "/api/admin/telegram/chats"),
  disconnectSlack: () => request<void>("DELETE", "/api/admin/slack"),
  syncSlack: () => request<{ status: "queued" }>("POST", "/api/admin/slack/sync"),
  slackTestMessage: (channel: string) =>
    request<{ ok: true }>("POST", "/api/admin/slack/test-message", { channel }),
  disconnectTelegram: () => request<void>("DELETE", "/api/admin/telegram"),
  telegramTestMessage: (chatId: string) =>
    request<{ ok: true }>("POST", "/api/admin/telegram/test-message", { chatId }),
  status: () => request<AdminStatus>("GET", "/api/admin/status"),
  configVersions: (before?: string) =>
    request<{ items: ConfigVersionRow[]; nextBefore: string | null }>(
      "GET",
      `/api/admin/config/versions${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  configVersion: (id: string) =>
    request<ConfigVersionDetails>("GET", `/api/admin/config/versions/${id}`),
  attention: () => request<Attention>("GET", "/api/admin/attention"),
  maintenance: () => request<MaintenanceStatus>("GET", "/api/admin/maintenance"),
  syncPeople: () => request<{ status: "queued" }>("POST", "/api/admin/maintenance/sync"),
  runRetention: () => request<RetentionReport>("POST", "/api/admin/maintenance/retention"),
  reloadConfig: () =>
    request<{ status: string; reason?: string }>("POST", "/api/admin/config/reload"),
  notifications: (params: {
    status?: string;
    route?: string;
    source?: string;
    period?: string;
    before?: string;
  }) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    return request<{ items: NotificationRow[]; nextBefore: string | null }>(
      "GET",
      `/api/admin/notifications?${q}`,
    );
  },
  testTargets: (routeId: string) =>
    request<{ configVersion: string; targets: TestTarget[] }>(
      "GET",
      `/api/admin/routes/${encodeURIComponent(routeId)}/test`,
    ),
  /** `configVersion` is the config whose places the admin confirmed; another one is refused. */
  testRoute: (routeId: string, configVersion: string) =>
    request<{ notificationId: string }>(
      "POST",
      `/api/admin/routes/${encodeURIComponent(routeId)}/test`,
      { configVersion },
    ),
  notificationCount: (params: Record<string, string | undefined> & { after: string }) =>
    request<{ count: number }>(
      "GET",
      `/api/admin/notifications/count?${new URLSearchParams(
        Object.entries(params).filter(([, v]) => v) as [string, string][],
      )}`,
    ),
  notification: (id: string) =>
    request<NotificationDetails>("GET", `/api/admin/notifications/${id}`),
  cancelNotification: (id: string) =>
    request<{ status: "cancelled" }>("POST", `/api/admin/notifications/${id}/cancel`),
  retryNotification: (id: string) =>
    request<{ status: "accepted" }>("POST", `/api/admin/notifications/${id}/retry`),
  people: (params: { q: string; status: string; page: string }) => {
    const q = new URLSearchParams(params);
    return request<{ items: AdminPerson[]; total: number; pageSize: number }>(
      "GET",
      `/api/admin/people?${q}`,
    );
  },
  peopleOptions: () => request<PersonOption[]>("GET", "/api/admin/people/options"),
  person: (id: string) => request<PersonDetails>("GET", `/api/admin/people/${id}`),
  suggestedLinks: () => request<SuggestedLink[]>("GET", "/api/admin/identities/suggested"),
  unmapped: () => request<UnmappedRow[]>("GET", "/api/admin/unmapped"),
  confirmIdentity: (id: string) => request<void>("POST", `/api/admin/identities/${id}/confirm`),
  unlinkIdentity: (id: string) => request<void>("DELETE", `/api/admin/identities/${id}`),
  link: (personId: string, ref: string) =>
    request<{ ok: true }>("POST", "/api/admin/links", { personId, ref }),
  teams: () => request<TeamInfo[]>("GET", "/api/admin/teams"),
  admins: () => request<AdminsInfo>("GET", "/api/admin/admins"),
  grantAdmin: (personId: string) =>
    request<{ ok: true; changed: boolean }>("POST", "/api/admin/admins", { personId }),
  revokeAdmin: (personId: string) => request<void>("DELETE", `/api/admin/admins/${personId}`),
  apiKeys: () => request<ApiKeyInfo[]>("GET", "/api/admin/api-keys"),
  createApiKey: (name: string, direct: boolean) =>
    request<ApiKeyInfo & { key: string }>("POST", "/api/admin/api-keys", { name, direct }),
  revokeApiKey: (name: string) =>
    request<void>("DELETE", `/api/admin/api-keys/${encodeURIComponent(name)}`),
  hooks: () => request<HookInfo[]>("GET", "/api/admin/hooks"),
  /** `path` holds the token and is returned only here. */
  createHook: (name: string, route: string) =>
    request<Omit<HookInfo, "routeMissing"> & { path: string }>("POST", "/api/admin/hooks", {
      name,
      route,
    }),
  revokeHook: (name: string) =>
    request<void>("DELETE", `/api/admin/hooks/${encodeURIComponent(name)}`),
  places: () => request<PlaceInfo[]>("GET", "/api/admin/places"),
};
