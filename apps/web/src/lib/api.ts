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
  destinations: { provider: "slack" | "telegram"; destination: string; label?: string }[];
  dm: boolean;
  mentions: "recipients" | "none";
  allowedSources: { github_repos: string[]; api_keys: string[] };
  dataFields: string[];
  muted: boolean;
  url: string;
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
  "accepted" | "processing" | "delivered" | "partially_failed" | "failed";

export interface DeliverySummary {
  provider: "slack" | "telegram";
  destination: string;
  status: "pending" | "sent" | "failed";
}

export interface NotificationRow {
  id: string;
  route: string;
  status: NotificationStatus;
  source: { type: "github_oidc"; repository: string } | { type: "api_key"; apiKeyName: string };
  threadKey: string | null;
  createdAt: string;
  deliveries: DeliverySummary[];
}

export interface NotificationDetails extends Omit<NotificationRow, "deliveries"> {
  data: Record<string, unknown>;
  recipients: string[];
  update: boolean;
  deliveries: (DeliverySummary & {
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
  })[];
}

export interface AdminPerson {
  id: string;
  name: string;
  status: "active" | "inactive";
  identities: (Identity & { id: string })[];
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
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AdminStatus {
  org: string;
  configRepo: string;
  config: {
    active: { commitSha: string; routes: number } | null;
    latest: {
      commitSha: string;
      status: "valid" | "invalid";
      createdAt: string;
      issues: { errors?: ConfigIssue[]; warnings?: ConfigIssue[] } | null;
    } | null;
  };
  slack: { team: string; commands: boolean; lastSyncedAt: string | null } | null;
  telegram: { bot: string } | null;
  last24h: Partial<Record<NotificationStatus, number>>;
}

export interface ConfigIssue {
  file: string;
  path: (string | number)[];
  message: string;
}

export interface Onboarding {
  steps: {
    githubApp: { done: boolean; org: string };
    slack: { done: boolean; team: string | null };
    linkGithub: { done: boolean };
    telegram: { done: boolean; optional: true; bot: string | null };
    config: { done: boolean; repo: string; rejected: boolean };
    firstNotification: { done: boolean };
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
  status: () => request<AdminStatus>("GET", "/api/admin/status"),
  reloadConfig: () => request<{ status: string }>("POST", "/api/admin/config/reload"),
  notifications: (params: { status?: string; before?: string }) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    return request<{ items: NotificationRow[]; nextBefore: string | null }>(
      "GET",
      `/api/admin/notifications?${q}`,
    );
  },
  notification: (id: string) =>
    request<NotificationDetails>("GET", `/api/admin/notifications/${id}`),
  people: () => request<AdminPerson[]>("GET", "/api/admin/people"),
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
  createApiKey: (name: string) =>
    request<ApiKeyInfo & { key: string }>("POST", "/api/admin/api-keys", { name }),
  revokeApiKey: (name: string) =>
    request<void>("DELETE", `/api/admin/api-keys/${encodeURIComponent(name)}`),
};
