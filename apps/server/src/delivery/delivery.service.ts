import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  findRoute,
  parseRef,
  splitRecipients,
  type Config,
  type Ref,
  type Route,
} from "@callog/config-schema";
import { TemplateRenderError, type MentionResolver } from "@callog/templates";
import { and, asc, count, eq, inArray, lt, max, ne, sql } from "drizzle-orm";
import { MessageGoneError, type Channel, type ChannelId } from "../channels/channel";
import { ChannelRegistry } from "../channels/channel-registry";
import { DB, type Db } from "../db/db";
import { deliveries, notifications, type ProviderMessageRef, type TraceNote } from "../db/schema";
import { MetricsService } from "../metrics/metrics.service";
import { RecipientResolver, type Resolution } from "../routing/recipient-resolver";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import {
  defaultTargets,
  parseDestination,
  routeTargets,
  targetKey,
  type Target,
} from "./destinations";
import { PreferencesService } from "../identity/preferences.service";
import { PersonalCopies, type PersonalCopy } from "./personal-copies";
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
    private readonly personalCopies: PersonalCopies,
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
    const route = config && findRoute(config, notification.routeId);
    let rows = await this.deliveriesOf(notificationId);
    if (!config || !route) {
      return this.finish(notification, rows, "Route no longer exists in the config version");
    }
    const { people: recipients, places } = splitRecipients(notification.recipients);
    if (rows.length === 0) {
      rows = await this.createDeliveries(notification, route, config, recipients, places);
    }
    await this.setStatus(notification.id, "processing");

    const rendered = new Map<string, Promise<Rendered>>();
    let transientError: string | undefined;

    // A delivery that falls back adds another one to the end of the queue.
    const queue = rows.filter((d) => d.status === "pending");
    for (const delivery of queue) {
      try {
        // A post that stands in for personal copies says whom it is for.
        const standsFor =
          parseDestination(delivery.destination).kind === "place" ? delivery.forPeople : [];
        const key = [delivery.provider, ...standsFor].join("\n");
        if (!rendered.has(key)) {
          rendered.set(
            key,
            this.render(delivery.provider, notification, route, config, recipients, standsFor),
          );
        }
        const outcome = await rendered.get(key)!;
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
        // Out of attempts is as final as a refusal: the fallback gets its try in this run.
        const final = permanent || attempt >= maxAttempts;
        await this.patch(delivery, {
          attempts: delivery.attempts + 1,
          lastError: message,
          ...(final ? { status: "failed" as const } : {}),
        });
        if (final) {
          this.metrics.deliveries.inc({ provider: delivery.provider, status: "failed" });
          const next = await this.fallBack(delivery, rows);
          if (next) {
            rows.push(next);
            queue.push(next);
          }
        }
        if (!permanent) transientError = message;
        this.logger.warn(
          `Delivery ${delivery.id} to ${delivery.provider}:${delivery.destination} ` +
            `${final ? "failed" : `will retry (attempt ${attempt}/${maxAttempts})`}: ${message}`,
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
    const notes: TraceNote[] = [];
    // Unmapped recipients are counted once per notification, not per retry.
    const counted = new Set<ChannelId>();
    const mentionable = new Set<string>();
    if (route.mentions !== "none") {
      for (const provider of new Set(targets.map((t) => t.provider))) {
        const resolution = await this.resolver.resolve(
          notification.tenantId,
          config,
          recipients,
          provider,
        );
        await this.resolver.recordUnmapped(
          notification.tenantId,
          resolution.unmapped,
          provider,
          route.id,
          resolution.reasons,
        );
        counted.add(provider);
        for (const ref of resolution.unmapped) {
          const detail = resolution.reasons.get(ref);
          notes.push({ recipient: ref, note: "not_mentioned", channel: provider, detail });
        }
        resolution.refs.forEach((r) => r.persons.forEach((p) => mentionable.add(p.personId)));
      }
      // With personal copies, the plan below says who muted the route.
      if (!route.dm) {
        for (const personId of await this.preferences.mutedAmong([...mentionable], route.id)) {
          notes.push({ recipient: `person:${personId}`, note: "muted" });
        }
      }
    }
    const planned = new Map<string, Target & Partial<PersonalCopy>>();
    const plan = (copy: Target & Partial<PersonalCopy>) => {
      const key = targetKey(copy);
      const existing = planned.get(key);
      // A room that already gets the notification needs no second message, only the names.
      if (existing) existing.forPeople = [...(existing.forPeople ?? []), ...(copy.forPeople ?? [])];
      else planned.set(key, { ...copy });
    };
    targets.forEach(plan);
    if (route.dm) {
      const personal = await this.personalCopies.plan(
        notification.tenantId,
        route,
        config,
        recipients,
      );
      personal.copies.forEach(plan);
      notes.push(...personal.notes);
      // Someone with no account anywhere got no copy: an admin has to see that.
      for (const channel of this.channels.all()) {
        if (counted.has(channel.id)) continue;
        await this.resolver.recordUnmapped(
          notification.tenantId,
          personal.unreached,
          channel.id,
          route.id,
          personal.reasons,
        );
      }
    }
    if (planned.size === 0) defaultTargets(route, config, this.channels).forEach(plan);
    if (notes.length > 0) {
      await this.db
        .update(notifications)
        .set({ trace: notes })
        .where(eq(notifications.id, notification.id));
    }
    if (planned.size === 0) return [];
    return this.db
      .insert(deliveries)
      .values(
        [...planned.values()].map((copy) => ({
          tenantId: notification.tenantId,
          notificationId: notification.id,
          ...copy,
        })),
      )
      .returning();
  }

  /**
   * Hands a delivery that failed for good over to the first of its fallbacks that has not
   * failed too: a delivery already on its way there, which then also stands for these
   * people, or a new one. Returns the new delivery, if one was made.
   */
  private async fallBack(failed: Delivery, rows: Delivery[]): Promise<Delivery | undefined> {
    for (const [i, target] of failed.fallbacks.entries()) {
      const existing = rows.find((row) => targetKey(row) === targetKey(target));
      if (existing?.status === "failed") continue;
      if (existing?.status === "pending") {
        await this.patch(existing, {
          forPeople: [...new Set([...existing.forPeople, ...failed.forPeople])],
        });
      }
      const [created] = existing
        ? []
        : await this.db
            .insert(deliveries)
            .values({
              tenantId: failed.tenantId,
              notificationId: failed.notificationId,
              ...target,
              forPeople: failed.forPeople,
              fallbacks: failed.fallbacks.slice(i + 1),
            })
            .returning();
      await this.patch(failed, { fallbackTo: (existing ?? created!).id });
      this.logger.warn(
        `Delivery ${failed.id} falls back to ${target.provider}:${target.destination}`,
      );
      return created;
    }
    return undefined;
  }

  /** Changes a delivery in the database and in the row this run holds, so they agree. */
  private async patch(row: Delivery, change: Partial<Delivery>): Promise<void> {
    Object.assign(row, change);
    await this.db.update(deliveries).set(change).where(eq(deliveries.id, row.id));
  }

  /** Renders once per channel per attempt; template errors become permanent failures. */
  private async render(
    provider: Delivery["provider"],
    notification: Notification,
    route: Route,
    config: Config,
    recipients: Ref[],
    standsFor: Ref[],
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
      const names = await this.namesOf(notification.tenantId, config, standsFor, channel.id);
      const input = { data: notification.data, recipients, fallback_for: names };
      let shown = await this.withRepeats(route, notification);
      // The post that replaces personal copies starts with whom it is for.
      if (names.length > 0) shown = withContext(shown, STANDS_FOR, "first");
      const mention = await this.mentionFor(route, resolution);
      return { channel, message: channel.render(shown, input, mention) };
    } catch (err) {
      if (err instanceof TemplateRenderError) {
        return new PermanentFailure(`Template error at ${err.message}`);
      }
      throw err;
    }
  }

  /** People who muted the route are not mentioned in it either. */
  private async mentionFor(route: Route, resolution: Resolution): Promise<MentionResolver> {
    const personIds = resolution.refs.flatMap((r) => r.persons.map((p) => p.personId));
    if (personIds.length === 0) return resolution.mention;
    const muted = await this.preferences.mutedAmong(personIds, route.id);
    return muted.size > 0 ? resolution.mentionWithout(muted) : resolution.mention;
  }

  /** What to call the people a post stands for: their name, or the visible part of the ref. */
  private async namesOf(
    tenantId: string,
    config: Config,
    refs: Ref[],
    channelId: ChannelId,
  ): Promise<string[]> {
    if (refs.length === 0) return [];
    const resolution = await this.resolver.resolve(tenantId, config, refs, channelId);
    return resolution.refs.map(
      ({ ref, persons }) => persons[0]?.displayName ?? parseRef(ref).value,
    );
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
    return withContext(route, `Repeated ${group.count} times, last at ${time} UTC`, "last");
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
    const status = overallStatus(rows);
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

/** A failed delivery whose fallback got through does not count against the notification. */
function overallStatus(rows: Delivery[]): NotificationStatus {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const madeUpFor = (row: Delivery): boolean => {
    let last = row;
    for (let next = byId.get(last.fallbackTo ?? ""); next; next = byId.get(last.fallbackTo ?? "")) {
      last = next;
    }
    return last !== row && last.status === "sent";
  };
  const counted = rows.filter((row) => row.status === "sent" || !madeUpFor(row));
  const sent = counted.filter((row) => row.status === "sent").length;
  if (sent === 0) return "failed";
  return sent === counted.length ? "delivered" : "partially_failed";
}

const STANDS_FOR = "For {{ fallback_for | join: ', ' }}";

/** The route with one more line of small print, before or after its template. */
function withContext(route: Route, context: string, where: "first" | "last"): Route {
  const template =
    where === "first" ? [{ context }, ...route.template] : [...route.template, { context }];
  return { ...route, template };
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
