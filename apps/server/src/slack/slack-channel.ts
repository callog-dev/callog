import { Injectable } from "@nestjs/common";
import type { Route } from "@callog/config-schema";
import {
  renderSlack,
  type MentionResolver,
  type RenderInput,
  type SlackMessage,
} from "@callog/templates";
import {
  MessageGoneError,
  type Channel,
  type ClassifiedError,
  type Destination,
  type MessageRef,
} from "../channels/channel";
import { SlackApiError } from "./slack-api";
import { SLACK_CHANNEL_ID, SlackSender } from "./slack-sender";

/** Slack errors worth retrying; everything else from Slack is a permanent failure. */
const TRANSIENT = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);
/** Slack errors meaning the message to edit no longer exists. */
const GONE = new Set(["message_not_found", "cant_update_message", "channel_not_found"]);

@Injectable()
export class SlackChannel implements Channel<"slack", SlackMessage> {
  readonly id = "slack";

  constructor(private readonly sender: SlackSender) {}

  /** `fe-alerts` and `#fe-alerts` are the same channel; ids are kept as is. */
  normalizePlace(place: string): string {
    return SLACK_CHANNEL_ID.test(place) || place.startsWith("#") ? place : `#${place}`;
  }

  /** Slack allows about one message per second per channel. */
  minIntervalMs(): number {
    return 1100;
  }

  canRender(): boolean {
    return true;
  }

  render(route: Route, input: RenderInput, mention: MentionResolver): SlackMessage {
    return renderSlack(route, input, { mention }).message;
  }

  async send(
    tenantId: string,
    to: Destination,
    message: SlackMessage,
    replyTo?: MessageRef<"slack">,
  ): Promise<MessageRef<"slack">> {
    const payload = { ...message, threadTs: replyTo?.ts };
    const posted =
      to.kind === "person"
        ? await this.sender.postDirect(tenantId, to.id, payload)
        : await this.sender.postToChannel(tenantId, to.id, payload);
    return { provider: "slack", channel: posted.channel, ts: posted.ts };
  }

  async edit(tenantId: string, ref: MessageRef<"slack">, message: SlackMessage): Promise<void> {
    try {
      await this.sender.update(tenantId, ref.channel, ref.ts, message);
    } catch (err) {
      if (err instanceof SlackApiError && GONE.has(err.code)) {
        throw new MessageGoneError(`${ref.channel}/${ref.ts}: ${err.code}`);
      }
      throw err;
    }
  }

  classifyError(err: unknown): ClassifiedError | undefined {
    if (!(err instanceof SlackApiError)) return undefined;
    return {
      permanent: !TRANSIENT.has(err.code),
      message: `slack: ${err.code}`,
      retryAfterSeconds: err.retryAfter,
    };
  }
}
