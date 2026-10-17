import {
  SlackApiError,
  type SlackApi,
  type SlackChannel,
  type SlackMessagePayload,
  type SlackUser,
  type SlackUsergroup,
} from "../../src/slack/slack-api";
import type { SlackSocketClient } from "../../src/slack/slack-socket";

export const GOOD_SLACK_TOKEN = "xoxb-test-good";
/** Any other `xapp-` token passes the app-level token check. */
export const BAD_SLACK_APP_TOKEN = "xapp-test-bad";

type SocketHandler = (args: {
  body: Record<string, unknown>;
  ack: (r?: object) => Promise<void>;
}) => Promise<void>;

/** A Socket Mode client that never connects anywhere; tests drive its handlers. */
export class FakeSlackSocket {
  readonly handlers = new Map<string, SocketHandler>();
  starts = 0;
  disconnected = false;

  constructor(
    readonly appToken: string,
    private readonly failures: Error[],
  ) {}

  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler);
    return this;
  }

  async start() {
    this.starts++;
    const failure = this.failures.shift();
    if (failure) throw failure;
    return {};
  }

  async disconnect() {
    this.disconnected = true;
  }
}

/** In-memory Slack workspace. One instance serves every token; only GOOD_SLACK_TOKEN is valid. */
export class FakeSlack {
  users: SlackUser[] = [];
  channels: SlackChannel[] = [{ id: "C0ALERTS1", name: "alerts" }];
  usergroups: SlackUsergroup[] = [];
  posted: { channel: string; message: SlackMessagePayload; ts?: string }[] = [];
  updated: { channel: string; ts: string; message: SlackMessagePayload }[] = [];
  /** ts values of messages that were deleted in Slack (updates fail with message_not_found). */
  deletedTs = new Set<string>();
  listChannelsCalls = 0;
  /** Errors thrown by the next postMessage calls, in order. */
  failures: SlackApiError[] = [];
  /** Socket Mode clients created, newest last; errors their next starts throw. */
  sockets: FakeSlackSocket[] = [];
  socketFailures: Error[] = [];

  socketFactory = (appToken: string) => {
    const socket = new FakeSlackSocket(appToken, this.socketFailures);
    this.sockets.push(socket);
    return socket as unknown as SlackSocketClient;
  };

  factory = (token: string): SlackApi => {
    const valid = token === GOOD_SLACK_TOKEN;
    const guard = <T>(fn: () => T): Promise<T> =>
      valid ? Promise.resolve(fn()) : Promise.reject(new SlackApiError("invalid_auth"));
    return {
      authTest: () =>
        guard(() => ({ teamId: "T0TEST", teamName: "test-team", botUserId: "U0BOT" })),
      checkAppToken: () =>
        token.startsWith("xapp-") && token !== BAD_SLACK_APP_TOKEN
          ? Promise.resolve()
          : Promise.reject(new SlackApiError("invalid_auth")),
      listUsers: () => guard(() => this.users),
      listChannels: () =>
        guard(() => {
          this.listChannelsCalls++;
          return this.channels;
        }),
      listUsergroups: () => guard(() => this.usergroups),
      openDm: (userId) => guard(() => `D${userId}`),
      postMessage: (channel, message) =>
        guard(() => {
          const failure = this.failures.shift();
          if (failure) throw failure;
          const ts = `1700000000.${String(this.posted.length + 1).padStart(6, "0")}`;
          this.posted.push({ channel, message, ts });
          return { channel, ts };
        }),
      updateMessage: (channel, ts, message) =>
        guard(() => {
          if (this.deletedTs.has(ts)) throw new SlackApiError("message_not_found");
          this.updated.push({ channel, ts, message });
          return { channel, ts };
        }),
    };
  };

  user(id: string, name: string, email?: string, extra: Partial<SlackUser> = {}): SlackUser {
    return { id, name, realName: name, email, deleted: false, isBot: false, ...extra };
  }
}
