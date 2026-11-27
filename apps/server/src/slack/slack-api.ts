import { WebClient, type WebAPICallError } from "@slack/web-api";

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  email: string | undefined;
  deleted: boolean;
  isBot: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
}

/** Which channels a listing covers: the ones the bot is a member of, or every public one. */
export type SlackChannelScope = "member" | "public";

export interface SlackChannelPage {
  /** May be short or empty with more pages still to come. */
  channels: SlackChannel[];
  /** Absent on the last page. */
  nextCursor: string | undefined;
}

export interface SlackUsergroup {
  id: string;
  handle: string;
  users: string[];
}

export interface SlackPostResult {
  channel: string;
  ts: string;
}

export interface SlackMessagePayload {
  text: string;
  blocks?: Record<string, unknown>[];
  threadTs?: string;
}

/**
 * The Slack Web API surface the server uses, in our own terms. Keeps
 * @slack/web-api out of the rest of the code and makes Slack easy to fake in tests.
 */
export interface SlackApi {
  authTest(): Promise<{ teamId: string; teamName: string; botUserId: string }>;
  /**
   * For an app-level token (`xapp-…`): asks for a Socket Mode URL to prove the token works.
   * The URL itself is not used.
   */
  checkAppToken(): Promise<void>;
  listUsers(): Promise<SlackUser[]>;
  /** One page of unarchived channels; pass the previous page's `nextCursor` to go on. */
  listChannelPage(scope: SlackChannelScope, cursor?: string): Promise<SlackChannelPage>;
  /** A channel by its id; `channel_not_found` when it is gone or closed to the bot. */
  channelInfo(id: string): Promise<{ name: string; archived: boolean }>;
  listUsergroups(): Promise<SlackUsergroup[]>;
  openDm(userId: string): Promise<string>;
  postMessage(channel: string, message: SlackMessagePayload): Promise<SlackPostResult>;
  /** Replaces the text/blocks of a message the bot posted. */
  updateMessage(
    channel: string,
    ts: string,
    message: SlackMessagePayload,
  ): Promise<SlackPostResult>;
}

/** Slack refused one of the tokens being connected. */
export class SlackTokenRejectedError extends Error {
  constructor(
    readonly token: "bot" | "app",
    readonly code: string,
  ) {
    super(`Slack rejected the ${token === "bot" ? "bot" : "app-level"} token: ${code}`);
    this.name = "SlackTokenRejectedError";
  }
}

/** A Slack API error with the Slack error code (`channel_not_found`, `ratelimited`, …). */
export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    /** Seconds to wait before retrying, for `ratelimited`. */
    readonly retryAfter?: number,
  ) {
    super(`Slack API error: ${code}`);
    this.name = "SlackApiError";
  }
}

export type SlackApiFactory = (botToken: string) => SlackApi;
export const SLACK_API_FACTORY = Symbol("SLACK_API_FACTORY");

export const createSlackApi: SlackApiFactory = (botToken) => new WebClientSlackApi(botToken);

/** The most Slack returns per page: fewer requests against the per-minute rate limit. */
const CHANNEL_PAGE_SIZE = 999;
/** A hung request must not hold a worker slot. */
const REQUEST_TIMEOUT_MS = 15_000;

class WebClientSlackApi implements SlackApi {
  private readonly client: WebClient;
  /**
   * Posting and editing never retry inside the client: a retried timeout can post the
   * same message twice. Delivery retries are owned by our queue.
   */
  private readonly writes: WebClient;

  constructor(token: string) {
    // Rate limits surface as errors and are waited out by the caller.
    const options = { rejectRateLimitedCalls: true, timeout: REQUEST_TIMEOUT_MS };
    this.client = new WebClient(token, { ...options, retryConfig: { retries: 2 } });
    this.writes = new WebClient(token, { ...options, retryConfig: { retries: 0 } });
  }

  authTest() {
    return call(async () => {
      const res = await this.client.auth.test();
      return { teamId: res.team_id!, teamName: res.team!, botUserId: res.user_id! };
    });
  }

  checkAppToken() {
    return call(async () => {
      await this.client.apps.connections.open({});
    });
  }

  listUsers() {
    return call(async () => {
      const users: SlackUser[] = [];
      for await (const page of this.client.paginate("users.list", { limit: 200 })) {
        for (const m of (page as { members?: RawUser[] }).members ?? []) {
          users.push({
            id: m.id,
            name: m.name ?? m.id,
            realName: m.profile?.real_name || m.real_name || m.name || m.id,
            email: m.profile?.email || undefined,
            deleted: m.deleted ?? false,
            isBot: Boolean(m.is_bot || m.is_app_user || m.id === "USLACKBOT"),
          });
        }
      }
      return users;
    });
  }

  listChannelPage(scope: SlackChannelScope, cursor?: string) {
    return call(async () => {
      const page = { limit: CHANNEL_PAGE_SIZE, cursor, exclude_archived: true };
      // users.conversations is in a higher rate limit tier than conversations.list and
      // returns only what the bot is in, private channels included.
      const res =
        scope === "member"
          ? await this.client.users.conversations({
              ...page,
              types: "public_channel,private_channel",
            })
          : await this.client.conversations.list({ ...page, types: "public_channel" });
      return {
        channels: (res.channels ?? []).flatMap((c) =>
          c.id && c.name ? [{ id: c.id, name: c.name }] : [],
        ),
        nextCursor: res.response_metadata?.next_cursor || undefined,
      };
    });
  }

  channelInfo(id: string) {
    return call(async () => {
      const { channel } = await this.client.conversations.info({ channel: id });
      return { name: channel?.name ?? "", archived: channel?.is_archived ?? false };
    });
  }

  listUsergroups() {
    return call(async () => {
      const res = await this.client.usergroups.list({ include_users: true });
      return (res.usergroups ?? []).map((g) => ({
        id: g.id!,
        handle: g.handle!,
        users: g.users ?? [],
      }));
    });
  }

  openDm(userId: string) {
    return call(async () => {
      const res = await this.client.conversations.open({ users: userId });
      return res.channel!.id!;
    });
  }

  postMessage(channel: string, message: SlackMessagePayload) {
    return call(async () => {
      const res = await this.writes.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks as never,
        thread_ts: message.threadTs,
        unfurl_links: false,
      });
      return { channel: res.channel!, ts: res.ts! };
    });
  }

  updateMessage(channel: string, ts: string, message: SlackMessagePayload) {
    return call(async () => {
      const res = await this.writes.chat.update({
        channel,
        ts,
        text: message.text,
        blocks: message.blocks as never,
      });
      return { channel: res.channel!, ts: res.ts! };
    });
  }
}

interface RawUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { email?: string; real_name?: string };
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as WebAPICallError & { data?: { error?: string }; retryAfter?: number };
    if (e.code === "slack_webapi_rate_limited_error")
      throw new SlackApiError("ratelimited", e.retryAfter);
    if (e.code === "slack_webapi_platform_error" && e.data?.error)
      throw new SlackApiError(e.data.error);
    throw err;
  }
}
