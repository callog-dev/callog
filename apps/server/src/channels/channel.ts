import type { Route } from "@callog/config-schema";
import type { MentionResolver, RenderInput } from "@callog/templates";
import type { Provider, ProviderMessageRef } from "../db/schema";

/** Providers a notification can be delivered through; the rest only identify people. */
export type ChannelId = Extract<Provider, "slack" | "telegram">;

/** A message posted through channel `Id`, as stored with its delivery. */
export type MessageRef<Id extends ChannelId = ChannelId> = Extract<
  ProviderMessageRef,
  { provider: Id }
>;

/** Where one delivery goes: a shared place of the channel, or a person's own chat. */
export interface Destination {
  kind: "place" | "person";
  /** The place as written in the config, or the person's account id in the channel. */
  id: string;
}

export interface ClassifiedError {
  /** Retrying cannot help: bad destination, revoked access, malformed message. */
  permanent: boolean;
  message: string;
  /** How long the API asked to wait before the next call. */
  retryAfterSeconds?: number;
}

/** Thrown by `Channel.edit` when the message to edit no longer exists. */
export class MessageGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageGoneError";
  }
}

/**
 * A messenger the delivery pipeline can send to. The pipeline owns queueing, retries,
 * rate limiting and threads; a channel turns a notification into its own message format
 * and talks to its API.
 */
export interface Channel<Id extends ChannelId = ChannelId, Message = unknown> {
  readonly id: Id;

  /** Canonical spelling of a place, so the same place is delivered to once. */
  normalizePlace?(place: string): string;

  /** Minimum gap between two messages to the destination, in milliseconds. */
  minIntervalMs(to: Destination): number;

  /** Throws `TemplateRenderError` on a broken template. */
  render(route: Route, input: RenderInput, mention: MentionResolver): Message;

  /** Posts a new message; as a reply to `replyTo` when given and the channel has threads. */
  send(
    tenantId: string,
    to: Destination,
    message: Message,
    replyTo?: MessageRef<Id>,
  ): Promise<MessageRef<Id>>;

  /** Replaces a message posted earlier. Channels without editing leave this out. */
  edit?(tenantId: string, ref: MessageRef<Id>, message: Message): Promise<void>;

  /** Sorts out an error of this channel's API; `undefined` for errors it does not know. */
  classifyError(err: unknown): ClassifiedError | undefined;
}
