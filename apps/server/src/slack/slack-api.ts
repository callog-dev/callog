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
  listUsers(): Promise<SlackUser[]>;
  listChannels(): Promise<SlackChannel[]>;
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

  listChannels() {
    return call(async () => {
      const channels: SlackChannel[] = [];
      for await (const page of this.client.paginate("conversations.list", {
        limit: 200,
        exclude_archived: true,
        types: "public_channel,private_channel",
      })) {
        for (const c of (page as { channels?: { id: string; name: string }[] }).channels ?? []) {
          channels.push({ id: c.id, name: c.name });
        }
      }
      return channels;
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
