import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ownValue,
  splitRecipients,
  type Config,
  type Ref,
  type Route,
} from "@callog/config-schema";
import { TemplateRenderError } from "@callog/templates";
import { and, asc, count, eq, inArray, lt, max, ne, sql } from "drizzle-orm";
import { MessageGoneError, type Channel, type ChannelId } from "../channels/channel";
import { ChannelRegistry } from "../channels/channel-registry";
import { DB, type Db } from "../db/db";
import { deliveries, notifications, type ProviderMessageRef } from "../db/schema";
import { MetricsService } from "../metrics/metrics.service";
import { RecipientResolver } from "../routing/recipient-resolver";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import {
  defaultTargets,
  parseDestination,
  personalTarget,
  routeTargets,
  type Target,
} from "./destinations";
import { PreferencesService } from "../identity/preferences.service";
import { DESTINATION_RATE_LIMITER, DestinationRateLimiter } from "./rate-limiter";

type Notification = typeof notifications.$inferSelect;
type Delivery = typeof deliveries.$inferSelect;
type NotificationStatus = Notification["status"];

/** A short rate limit is waited out inside the job; longer ones fall back to the job backoff. */
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

interface ThreadContext {
  root: ProviderMessageRef | undefined;
  update: boolean;
}

/** A message in the channel's own format, or why there is none. */
type Rendered = { channel: Channel; message: unknown } | PermanentFailure;

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
    private readonly channels: ChannelRegistry,
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
    // A retry (NotificationsService.retry) reopens a finished notification first.
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
    const { people: recipients, places } = splitRecipients(notification.recipients);
    if (rows.length === 0) {
      rows = await this.createDeliveries(notification, route, config, recipients, places);
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
        const outcome = await rendered.get(delivery.provider)!;
        if (outcome instanceof PermanentFailure) throw outcome;
        const ref = await this.send(
          outcome.channel,
          notification.tenantId,
          delivery.destination,
          outcome.message,
          { root: await this.threadRoot(notification, delivery), update: notification.update },
        );
        await this.markSent(delivery, ref);
        this.metrics.deliveries.inc({ provider: delivery.provider, status: "sent" });
        this.metrics.deliveryLatency.observe(
          { provider: delivery.provider },
          (Date.now() - notification.createdAt.getTime()) / 1000,
        );
      } catch (err) {
        const { permanent, message } = classify(err, this.channels.get(delivery.provider));
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
    places: string[],
  ): Promise<Delivery[]> {
    const targets = routeTargets(route, config, this.channels, places);
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
    if (targets.length === 0) targets.push(...defaultTargets(route, config, this.channels));
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
   * once, in their preferred channel — falling back to another one they have — unless
   * they muted the route. Destinations are `dm:<account id>`.
   */
  private async dmTargets(
    tenantId: string,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<Target[]> {
    const channelIds = this.channels.all().map((c) => c.id);
    const accounts = new Map<string, Map<ChannelId, string>>();
    for (const channelId of channelIds) {
      const resolution = await this.resolver.resolve(tenantId, config, recipients, channelId);
      for (const person of resolution.refs.flatMap((r) => r.persons)) {
        const ids = accounts.get(person.personId) ?? new Map<ChannelId, string>();
        if (person.target) ids.set(channelId, person.target.externalId);
        accounts.set(person.personId, ids);
      }
    }
    const prefs = await this.preferences.getMany([...accounts.keys()]);
    const targets: Target[] = [];
    for (const [personId, ids] of accounts) {
      const pref = prefs.get(personId)!;
      if (pref.mutedRoutes.includes(route.id)) continue;
      const provider = [pref.dmChannel, ...channelIds].find((id) => ids.has(id));
      if (provider) targets.push(personalTarget(provider, ids.get(provider)!));
    }
    return targets;
  }

  /** Renders once per channel per attempt; template errors become permanent failures. */
  private async render(
    provider: Delivery["provider"],
    notification: Notification,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<Rendered> {
    const channel = this.channels.get(provider);
    if (!channel) return new PermanentFailure(`${provider} is not a delivery channel`);
    const resolution = await this.resolver.resolve(
      notification.tenantId,
      config,
      recipients,
      channel.id,
    );
    try {
      const input = { data: notification.data, recipients };
      const shown = await this.withRepeats(route, notification);
      return { channel, message: channel.render(shown, input, resolution.mention) };
    } catch (err) {
      if (err instanceof TemplateRenderError) {
        return new PermanentFailure(`Template error at ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * A repeat of a grouped notification edits the group's first message; a footer says how
   * often it repeated. Counted now, so a retry of an older repeat does not count backwards.
   */
  private async withRepeats(route: Route, notification: Notification): Promise<Route> {
    if (!notification.groupKey || !notification.threadKey) return route;
    const [group] = await this.db
      .select({ count: count(), lastAt: max(notifications.createdAt) })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, notification.tenantId),
          eq(notifications.threadKey, notification.threadKey),
        ),
      );
    if (!group?.lastAt || group.count < 2) return route;
    const time = group.lastAt.toISOString().slice(11, 16);
    const context = `Repeated ${group.count} times, last at ${time} UTC`;
    return { ...route, template: [...route.template, { context }] };
  }

  /**
   * No root → new message; root → reply in its thread; root + update → edit the root
   * (falling back to a new message when it was deleted or the channel cannot edit).
   */
  private async send(
    channel: Channel,
    tenantId: string,
    destination: string,
    message: unknown,
    thread: ThreadContext,
  ): Promise<ProviderMessageRef> {
    const to = parseDestination(destination);
    await this.limiter.wait(`${tenantId}:${channel.id}:${destination}`, channel.minIntervalMs(to));
    const root = thread.root?.provider === channel.id ? thread.root : undefined;
    return withInlineRetry(channel, async () => {
      if (root && thread.update && channel.edit) {
        try {
          await channel.edit(tenantId, root, message);
          return root;
        } catch (err) {
          if (!(err instanceof MessageGoneError)) throw err;
          this.logger.warn(`Thread root is gone (${err.message}), posting a new message`);
        }
      }
      return channel.send(tenantId, to, message, thread.update ? undefined : root);
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

function classify(err: unknown, channel?: Channel): { permanent: boolean; message: string } {
  if (err instanceof PermanentFailure) return { permanent: true, message: err.message };
  const known = channel?.classifyError(err);
  if (known) return known;
  // Network errors, timeouts, bugs: retry.
  return { permanent: false, message: err instanceof Error ? err.message : String(err) };
}

/** Waits out a short rate limit once inside the job; anything else goes to the queue backoff. */
async function withInlineRetry<T>(channel: Channel, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = channel.classifyError(err)?.retryAfterSeconds;
    if (retryAfter === undefined || retryAfter > MAX_INLINE_RETRY_AFTER_S) throw err;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fn();
  }
}
