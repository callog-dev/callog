import { Inject, Injectable, Logger } from "@nestjs/common";
import { ownValue, type Config, type Ref, type Route } from "@callog/config-schema";
import {
  renderSlack,
  renderTelegram,
  TemplateRenderError,
  type SlackMessage,
  type TelegramMessage,
} from "@callog/templates";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { deliveries, notifications, type ProviderMessageRef } from "../db/schema";
import { MetricsService } from "../metrics/metrics.service";
import { RecipientResolver } from "../routing/recipient-resolver";
import { SlackApiError } from "../slack/slack-api";
import { SlackSender } from "../slack/slack-sender";
import { TelegramApiError } from "../telegram/telegram-api";
import { TelegramSender } from "../telegram/telegram-sender";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { routeTargets, type Target } from "./destinations";
import { PreferencesService } from "../identity/preferences.service";
import { DESTINATION_RATE_LIMITER, DestinationRateLimiter } from "./rate-limiter";

type Notification = typeof notifications.$inferSelect;
type Delivery = typeof deliveries.$inferSelect;
type NotificationStatus = Notification["status"];

/** Slack errors worth retrying; everything else from Slack is a permanent failure. */
const TRANSIENT_SLACK_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);
/** A short 429 is waited out inside the job; longer ones fall back to the job backoff. */
const MAX_INLINE_RETRY_AFTER_S = 30;

export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

/** Thrown to make the queue retry the job with backoff (some deliveries are still pending). */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryLater";
  }
}

class PermanentFailure extends Error {}

/** Destination of a personal copy: `dm:<Slack user id | Telegram user id>`. */
const DM_PREFIX = "dm:";

interface ThreadContext {
  root: ProviderMessageRef | undefined;
  update: boolean;
}

/** Slack errors meaning the message to edit no longer exists. */
const SLACK_GONE = new Set(["message_not_found", "cant_update_message", "channel_not_found"]);

type Rendered =
  | { provider: "slack"; message: SlackMessage }
  | { provider: "telegram"; message: TelegramMessage }
  | PermanentFailure;

/**
 * Delivers one notification to every destination of its route.
 * Safe to run repeatedly: sent deliveries are never re-sent, so a retry only redoes
 * what is still pending.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly configs: TenantConfigService,
    private readonly resolver: RecipientResolver,
    private readonly slack: SlackSender,
    private readonly telegram: TelegramSender,
    private readonly metrics: MetricsService,
    @Inject(DESTINATION_RATE_LIMITER) private readonly limiter: DestinationRateLimiter,
    private readonly preferences: PreferencesService,
  ) {}

  async deliver(notificationId: string, attempts: AttemptInfo): Promise<NotificationStatus> {
    const { attempt, maxAttempts } = attempts;
    const [notification] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    if (!notification) return "failed";
    if (["delivered", "failed", "partially_failed"].includes(notification.status))
      return notification.status;
    if (attempt < maxAttempts && (await this.earlierInThreadPending(notification))) {
      throw new RetryLater("waiting for an earlier notification of the thread");
    }
    try {
      return await this.attemptDelivery(notification, attempts);
    } catch (err) {
      if (err instanceof RetryLater || attempt < maxAttempts) throw err;
      // The queue will not run this job again: settle the notification instead of
      // leaving it `processing` forever.
      const rows = await this.deliveriesOf(notificationId);
      return this.finish(notification, rows, err instanceof Error ? err.message : String(err));
    }
  }

  private async attemptDelivery(
    notification: Notification,
    { attempt, maxAttempts }: AttemptInfo,
  ): Promise<NotificationStatus> {
    const notificationId = notification.id;
    const config = (await this.configs.getVersion(notification.configVersionId))?.config;
    const route = config && ownValue(config.routes, notification.routeId);
    let rows = await this.deliveriesOf(notificationId);
    if (!config || !route) {
      return this.finish(notification, rows, "Route no longer exists in the config version");
    }
    const recipients = notification.recipients as Ref[];
    if (rows.length === 0) {
      rows = await this.createDeliveries(notification, route, config, recipients);
    }
    await this.setStatus(notification.id, "processing");

    const rendered = new Map<Delivery["provider"], Promise<Rendered>>();
    let transientError: string | undefined;

    for (const delivery of rows.filter((d) => d.status === "pending")) {
      try {
        if (!rendered.has(delivery.provider)) {
          rendered.set(
            delivery.provider,
            this.render(delivery.provider, notification, route, config, recipients),
          );
        }
        const message = await rendered.get(delivery.provider)!;
        if (message instanceof PermanentFailure) throw message;
        const thread: ThreadContext = {
          root: await this.threadRoot(notification, delivery),
          update: notification.update,
        };
        const ref =
          message.provider === "slack"
            ? await this.sendSlack(
                notification.tenantId,
                delivery.destination,
                message.message,
                thread,
              )
            : await this.sendTelegram(
                notification.tenantId,
                delivery.destination,
                message.message,
                thread,
              );
        await this.markSent(delivery, ref);
        this.metrics.deliveries.inc({ provider: delivery.provider, status: "sent" });
        this.metrics.deliveryLatency.observe(
          { provider: delivery.provider },
          (Date.now() - notification.createdAt.getTime()) / 1000,
        );
      } catch (err) {
        const { permanent, message } = classify(err);
        await this.db
          .update(deliveries)
          .set({
            attempts: delivery.attempts + 1,
            lastError: message,
            ...(permanent ? { status: "failed" as const } : {}),
          })
          .where(eq(deliveries.id, delivery.id));
        if (permanent)
          this.metrics.deliveries.inc({ provider: delivery.provider, status: "failed" });
        else transientError = message;
        this.logger.warn(
          `Delivery ${delivery.id} to ${delivery.provider}:${delivery.destination} ` +
            `${permanent ? "failed" : `will retry (attempt ${attempt}/${maxAttempts})`}: ${message}`,
        );
      }
    }

    rows = await this.deliveriesOf(notificationId);
    const pending = rows.some((d) => d.status === "pending");
    if (pending && attempt < maxAttempts) {
      throw new RetryLater(transientError ?? "deliveries pending");
    }
    return this.finish(notification, rows, transientError ?? "retries exhausted");
  }

  private async createDeliveries(
    notification: Notification,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<Delivery[]> {
    const targets = routeTargets(route, config);
    // Unmapped recipients are counted once per notification, not per retry.
    for (const provider of new Set(targets.map((t) => t.provider))) {
      const resolution = await this.resolver.resolve(
        notification.tenantId,
        config,
        recipients,
        provider,
      );
      if (route.mentions !== "none") {
        await this.resolver.recordUnmapped(
          notification.tenantId,
          resolution.unmapped,
          provider,
          route.id,
          resolution.reasons,
        );
      }
    }
    if (route.dm)
      targets.push(...(await this.dmTargets(notification.tenantId, route, config, recipients)));
    if (targets.length === 0) return [];
    return this.db
      .insert(deliveries)
      .values(
        targets.map((t) => ({
          tenantId: notification.tenantId,
          notificationId: notification.id,
          ...t,
        })),
      )
      .returning();
  }

  /**
   * Personal copies for routes with `dm: true`: every recipient (teams expanded)
   * once, in their preferred channel — falling back to the other one they have — unless
   * they muted the route. Destinations are `dm:<account id>`.
   */
  private async dmTargets(
    tenantId: string,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<Target[]> {
    const accounts = new Map<string, Partial<Record<Target["provider"], string>>>();
    for (const provider of ["slack", "telegram"] as const) {
      // slack_blocks cannot be rendered for Telegram.
      if (provider === "telegram" && !route.template) continue;
      const resolution = await this.resolver.resolve(tenantId, config, recipients, provider);
      for (const person of resolution.refs.flatMap((r) => r.persons)) {
        const entry = accounts.get(person.personId) ?? {};
        if (person.target) entry[provider] = person.target.externalId;
        accounts.set(person.personId, entry);
      }
    }
    const prefs = await this.preferences.getMany([...accounts.keys()]);
    const targets: Target[] = [];
    for (const [personId, ids] of accounts) {
      const pref = prefs.get(personId)!;
      if (pref.mutedRoutes.includes(route.id)) continue;
      const order: Target["provider"][] =
        pref.dmChannel === "telegram" ? ["telegram", "slack"] : ["slack", "telegram"];
      const provider = order.find((p) => ids[p]);
      if (provider) targets.push({ provider, destination: `${DM_PREFIX}${ids[provider]}` });
    }
    return targets;
  }

  /** Renders once per provider per attempt; template errors become permanent failures. */
  private async render(
    provider: Delivery["provider"],
    notification: Notification,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<Rendered> {
    if (provider !== "slack" && provider !== "telegram") {
      return new PermanentFailure(`${provider} is not a delivery channel`);
    }
    const resolution = await this.resolver.resolve(
      notification.tenantId,
      config,
      recipients,
      provider,
    );
    const input = { data: notification.data, recipients };
    try {
      return provider === "slack"
        ? { provider, message: renderSlack(route, input, { mention: resolution.mention }).message }
        : {
            provider,
            message: renderTelegram(route, input, { mention: resolution.mention }).message,
          };
    } catch (err) {
      if (err instanceof TemplateRenderError) {
        return new PermanentFailure(`Template error at ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Slack: no root → new message; root → reply in its thread; root + update → edit the
   * root (falling back to a new message when it was deleted).
   */
  private async sendSlack(
    tenantId: string,
    channel: string,
    message: SlackMessage,
    thread: ThreadContext,
  ): Promise<ProviderMessageRef> {
    await this.limiter.wait(`${tenantId}:slack:${channel}`);
    const root = thread.root?.provider === "slack" ? thread.root : undefined;
    return withInlineRetry(slackRetryAfter, async () => {
      if (root && thread.update) {
        try {
          await this.slack.update(tenantId, root.channel, root.ts, message);
          return root;
        } catch (err) {
          if (!(err instanceof SlackApiError && SLACK_GONE.has(err.code))) throw err;
          this.logger.warn(`Thread root ${root.channel}/${root.ts} is gone, posting a new message`);
        }
      }
      const payload = { ...message, threadTs: root && !thread.update ? root.ts : undefined };
      const posted = channel.startsWith(DM_PREFIX)
        ? await this.slack.postDirect(tenantId, channel.slice(DM_PREFIX.length), payload)
        : await this.slack.postToChannel(tenantId, channel, payload);
      return { provider: "slack", channel: posted.channel, ts: posted.ts };
    });
  }

  /** Telegram: same modes — reply to the root, or edit it. */
  private async sendTelegram(
    tenantId: string,
    chatId: string,
    message: TelegramMessage,
    thread: ThreadContext,
  ): Promise<ProviderMessageRef> {
    // Group and channel ids are negative or @usernames; private chats are positive ids.
    const isGroup = chatId.startsWith("-") || chatId.startsWith("@");
    // A personal chat with a Telegram user has the user's id as its chat id.
    const targetChat = chatId.startsWith(DM_PREFIX) ? chatId.slice(DM_PREFIX.length) : chatId;
    await this.limiter.wait(
      `${tenantId}:telegram:${chatId}`,
      isGroup ? "telegramGroup" : "default",
    );
    const root = thread.root?.provider === "telegram" ? thread.root : undefined;
    return withInlineRetry(telegramRetryAfter, async () => {
      if (root && thread.update) {
        try {
          await this.telegram.edit(tenantId, root.chatId, root.messageId, message);
          return root;
        } catch (err) {
          if (!(
            err instanceof TelegramApiError && /not found|can't be edited/i.test(err.description)
          ))
            throw err;
          this.logger.warn(
            `Thread root ${root.chatId}/${root.messageId} is gone, posting a new message`,
          );
        }
      }
      const sent = await this.telegram.send(tenantId, targetChat, message, {
        replyToMessageId: root && !thread.update ? root.messageId : undefined,
      });
      return { provider: "telegram", chatId: sent.chatId, messageId: sent.messageId };
    });
  }

  /**
   * The thread queue alone does not keep order: graphile-worker unlocks a queue while its
   * failed job waits for the backoff, so a reply could run before its root is posted
   * (and become the root itself). On the last attempt the reply goes out regardless.
   */
  private async earlierInThreadPending(notification: Notification): Promise<boolean> {
    if (!notification.threadKey) return false;
    const [row] = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, notification.tenantId),
          eq(notifications.threadKey, notification.threadKey),
          // Compared in SQL: JS dates drop the microseconds of created_at.
          lt(
            notifications.createdAt,
            sql`(select created_at from notifications where id = ${notification.id})`,
          ),
          inArray(notifications.status, ["accepted", "processing"]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** First message delivered for this thread to this destination (`thread_key`). */
  private async threadRoot(
    notification: Notification,
    delivery: Delivery,
  ): Promise<ProviderMessageRef | undefined> {
    if (!notification.threadKey) return undefined;
    const [row] = await this.db
      .select({ ref: deliveries.providerMessageRef })
      .from(deliveries)
      .innerJoin(notifications, eq(notifications.id, deliveries.notificationId))
      .where(
        and(
          eq(notifications.tenantId, notification.tenantId),
          eq(notifications.threadKey, notification.threadKey),
          ne(notifications.id, notification.id),
          eq(deliveries.provider, delivery.provider),
          eq(deliveries.destination, delivery.destination),
          eq(deliveries.status, "sent"),
        ),
      )
      .orderBy(asc(deliveries.sentAt))
      .limit(1);
    return row?.ref ?? undefined;
  }

  private deliveriesOf(notificationId: string): Promise<Delivery[]> {
    return this.db.select().from(deliveries).where(eq(deliveries.notificationId, notificationId));
  }

  private async markSent(delivery: Delivery, ref: ProviderMessageRef): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: "sent",
        attempts: delivery.attempts + 1,
        lastError: null,
        providerMessageRef: ref,
        sentAt: new Date(),
      })
      .where(eq(deliveries.id, delivery.id));
  }

  /** Fails whatever is still pending and sets the final notification status. */
  private async finish(
    notification: Notification,
    rows: Delivery[],
    reason: string,
  ): Promise<NotificationStatus> {
    for (const d of rows.filter((r) => r.status === "pending")) {
      await this.db
        .update(deliveries)
        .set({ status: "failed", lastError: d.lastError ?? reason })
        .where(eq(deliveries.id, d.id));
      this.metrics.deliveries.inc({ provider: d.provider, status: "failed" });
    }
    const sent = rows.filter((r) => r.status === "sent").length;
    const status: NotificationStatus =
      rows.length === 0
        ? "failed"
        : sent === rows.length
          ? "delivered"
          : sent === 0
            ? "failed"
            : "partially_failed";
    await this.setStatus(notification.id, status);
    if (status !== "delivered") {
      this.logger.warn(`Notification ${notification.id} finished as ${status}: ${reason}`);
    }
    return status;
  }

  private async setStatus(id: string, status: NotificationStatus): Promise<void> {
    await this.db.update(notifications).set({ status }).where(eq(notifications.id, id));
  }
}

function classify(err: unknown): { permanent: boolean; message: string } {
  if (err instanceof PermanentFailure) return { permanent: true, message: err.message };
  if (err instanceof SlackApiError) {
    return { permanent: !TRANSIENT_SLACK_ERRORS.has(err.code), message: `slack: ${err.code}` };
  }
  if (err instanceof TelegramApiError) {
    // 429 and server-side errors are worth retrying; 400/403 (bad chat, bot removed) are not.
    return {
      permanent: err.code !== 429 && err.code < 500,
      message: `telegram: ${err.description}`,
    };
  }
  // Network errors, timeouts, bugs: retry.
  return { permanent: false, message: err instanceof Error ? err.message : String(err) };
}

const slackRetryAfter = (err: unknown) =>
  err instanceof SlackApiError ? err.retryAfter : undefined;
const telegramRetryAfter = (err: unknown) =>
  err instanceof TelegramApiError ? err.retryAfter : undefined;

/** Waits out a short 429 once inside the job; anything else goes to the queue backoff. */
async function withInlineRetry<T>(
  retryAfterOf: (err: unknown) => number | undefined,
  fn: () => Promise<T>,
) {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = retryAfterOf(err);
    if (retryAfter === undefined || retryAfter > MAX_INLINE_RETRY_AFTER_S) throw err;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fn();
  }
}
