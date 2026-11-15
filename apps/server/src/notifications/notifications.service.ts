import {
  Logger,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  DIRECT_ROUTE,
  findRoute,
  ownValue,
  placeOf,
  splitRecipients,
  type Route,
} from "@callog/config-schema";
import { renderGroupKey, renderRouteRecipients, TemplateRenderError } from "@callog/templates";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { AuditService, type AuditActor } from "../audit/audit.service";
import { sha256Hex } from "../crypto/digest";
import { DB, type Db } from "../db/db";
import { deliveries, idempotencyKeys, notifications } from "../db/schema";
import { ProducerAuthService, type Producer } from "../producers/producer-auth.service";
import { QueueService } from "../queue/queue.service";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { MetricsService } from "../metrics/metrics.service";
import { DataValidator } from "./data-validator";
import { GROUP_THREAD_PREFIX, MAX_RECIPIENTS, type NotifyRequest } from "./notify-request";

export const DELIVER_TASK = "notification.deliver";
/**
 * graphile-worker retries with exp(attempt) seconds: 8 attempts span ~30 minutes,
 * the delivery retry window.
 */
export const DELIVER_MAX_ATTEMPTS = 8;

function threadQueueName(tenantId: string, threadKey: string | null | undefined) {
  return threadKey ? `thread:${tenantId}:${threadKey}` : undefined;
}
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface Accepted {
  notificationId: string;
  /** True when this was a replay of an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Rolls back the insert transaction when another request already holds the idempotency key. */
class IdempotencyRace extends Error {}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly configs: TenantConfigService,
    private readonly auth: ProducerAuthService,
    private readonly dataValidator: DataValidator,
    private readonly queue: QueueService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  async accept(
    producer: Producer,
    request: NotifyRequest,
    idempotencyKey?: string,
  ): Promise<Accepted> {
    // A retry gets its notification back even if the config changed since; the producer
    // is part of the hash, so another producer reusing the key gets 409.
    const requestHash = hashRequest({ request, source: producer.source });
    if (idempotencyKey) {
      const replay = await this.findReplay(producer.tenantId, idempotencyKey, requestHash);
      if (replay) return { notificationId: replay, replayed: true };
    }

    const active = await this.configs.getActive(producer.tenantId);
    if (!active)
      throw new ServiceUnavailableException("No valid config is loaded for this organization");
    const route = findRoute(active.config, request.route);
    if (!route) throw new NotFoundException(`Route "${request.route}" not found`);
    this.auth.assertAllowed(route, producer);

    const isKnownPlace = (name: string) => ownValue(active.config.places, name) !== undefined;
    const unknownPlaces = splitRecipients(request.recipients).places.filter(
      (name) => !isKnownPlace(name),
    );
    if (unknownPlaces.length > 0) {
      throw new UnprocessableEntityException({
        message: "recipients name places that are not in places.yaml",
        places: unknownPlaces,
      });
    }

    if (route.schema) {
      const issues = this.dataValidator.validate(
        `${active.versionId}:${route.id}`,
        route.schema,
        request.data,
      );
      if (issues.length > 0) {
        throw new UnprocessableEntityException({
          message: "data does not match the route schema",
          issues,
        });
      }
    }

    // The route's own recipients come from data the sender may not control, so the ones
    // that lead nowhere are dropped instead of failing the request.
    const recipients = [
      ...new Set([
        ...request.recipients,
        ...(
          this.renderLeniently(route, "recipients", () =>
            renderRouteRecipients(route, request.data),
          ) ?? []
        ).filter((recipient) => {
          const place = placeOf(recipient);
          return place === undefined || isKnownPlace(place);
        }),
      ]),
    ].slice(0, MAX_RECIPIENTS);
    if (route.id === DIRECT_ROUTE.id && recipients.length === 0) {
      throw new UnprocessableEntityException("The direct route needs recipients");
    }

    try {
      const notificationId = await this.db.transaction(async (tx) => {
        const thread = await this.threadOf(tx, producer.tenantId, route, request);
        const [notification] = await tx
          .insert(notifications)
          .values({
            tenantId: producer.tenantId,
            routeId: route.id,
            configVersionId: active.versionId,
            source: producer.source,
            data: request.data,
            recipients,
            ...thread,
          })
          .returning({ id: notifications.id });
        const id = notification!.id;

        if (idempotencyKey) {
          const held = await tx
            .insert(idempotencyKeys)
            .values({
              tenantId: producer.tenantId,
              key: idempotencyKey,
              requestHash,
              notificationId: id,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            })
            .onConflictDoNothing()
            .returning({ key: idempotencyKeys.key });
          if (held.length === 0) throw new IdempotencyRace();
        }

        await this.enqueueDelivery(tx, producer.tenantId, id, thread.threadKey);
        return id;
      });
      this.metrics.notificationsReceived.inc({ route: route.id });
      return { notificationId, replayed: false };
    } catch (err) {
      if (!(err instanceof IdempotencyRace)) throw err;
      // A concurrent request with the same key won; answer like a replay.
      const replay = await this.findReplay(producer.tenantId, idempotencyKey!, requestHash);
      if (!replay)
        throw new ConflictException("Idempotency-Key is being used by a concurrent request");
      return { notificationId: replay, replayed: true };
    }
  }

  async get(tenantId: string, notificationId: string) {
    const [notification] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, notificationId)));
    if (!notification) throw new NotFoundException("Notification not found");
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.notificationId, notificationId));
    return {
      id: notification.id,
      route: notification.routeId,
      status: notification.status,
      thread_key: notification.threadKey,
      created_at: notification.createdAt,
      deliveries: rows.map((d) => ({
        id: d.id,
        provider: d.provider,
        destination: d.destination,
        status: d.status,
        attempts: d.attempts,
        last_error: d.lastError,
        sent_at: d.sentAt,
        /** The delivery that took over when this one failed for good. */
        fallback_to: d.fallbackTo,
      })),
    };
  }

  /**
   * Sends a finished notification's failed deliveries again, through its thread's queue so the
   * thread keeps its order. The attempt count of each delivery carries on. Relies on
   * `DeliveryService.deliver` sending exactly the pending deliveries of an unfinished
   * notification.
   */
  async retry(tenantId: string, notificationId: string, actor: AuditActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [notification] = await tx
        .select({ status: notifications.status, threadKey: notifications.threadKey })
        .from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, notificationId)))
        .for("update");
      if (!notification) throw new NotFoundException();
      if (notification.status !== "failed" && notification.status !== "partially_failed") {
        throw new ConflictException(`Nothing to retry: the notification is ${notification.status}`);
      }
      const retried = await tx
        .update(deliveries)
        .set({ status: "pending" })
        .where(
          and(
            eq(deliveries.notificationId, notificationId),
            eq(deliveries.status, "failed"),
            // What another delivery took over is not sent a second time.
            isNull(deliveries.fallbackTo),
          ),
        )
        .returning({ id: deliveries.id });
      await tx
        .update(notifications)
        .set({ status: "accepted" })
        .where(eq(notifications.id, notificationId));
      await this.enqueueDelivery(tx, tenantId, notificationId, notification.threadKey);
      await this.audit.record(
        {
          tenantId,
          action: "notification.retried",
          actor,
          details: { notificationId, deliveries: retried.length },
        },
        tx,
      );
    });
  }

  /**
   * The thread the notification goes to. A sender that names a thread keeps it. Otherwise a
   * route that groups puts repeats of the same key into one thread, each repeat editing its
   * first message, until the window after that first message is over.
   */
  private async threadOf(tx: Transaction, tenantId: string, route: Route, request: NotifyRequest) {
    const fromRequest = { threadKey: request.thread_key, update: request.update };
    if (!route.group || request.thread_key) return fromRequest;
    const groupKey = this.renderLeniently(route, "group key", () =>
      renderGroupKey(route, request.data),
    );
    if (groupKey === undefined) return fromRequest;

    // Repeats come in bursts: one at a time per group, so two of them cannot both open it.
    const group = `${tenantId}:${route.id}:${groupKey}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${group}, 0))`);
    const openedAt = sql<Date>`min(${notifications.createdAt})`;
    const [latest] = await tx
      .select({ threadKey: notifications.threadKey, openedAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.routeId, route.id),
          eq(notifications.groupKey, groupKey),
        ),
      )
      .groupBy(notifications.threadKey)
      .orderBy(desc(openedAt))
      .limit(1);
    const open =
      latest !== undefined &&
      new Date(latest.openedAt).getTime() > Date.now() - route.group.window * 1000;
    return open
      ? { threadKey: latest.threadKey, update: true, groupKey }
      : {
          threadKey: `${GROUP_THREAD_PREFIX}${route.id}:${sha256Hex(groupKey).slice(0, 16)}:${Date.now()}`,
          update: false,
          groupKey,
        };
  }

  /**
   * Config validation renders a route's expressions on its examples, but real data can
   * still break one. The sender cannot fix that, so the notification goes on without it.
   */
  private renderLeniently<T>(route: Route, what: string, render: () => T): T | undefined {
    try {
      return render();
    } catch (err) {
      if (!(err instanceof TemplateRenderError)) throw err;
      this.logger.warn(`Route "${route.id}" ${what} was not rendered: ${err.message}`);
      return undefined;
    }
  }

  /** Queued per thread: messages of one thread go out strictly in order. */
  private enqueueDelivery(
    tx: Parameters<QueueService["enqueue"]>[3],
    tenantId: string,
    notificationId: string,
    threadKey: string | null | undefined,
  ) {
    return this.queue.enqueue(
      DELIVER_TASK,
      { notificationId },
      { queueName: threadQueueName(tenantId, threadKey), maxAttempts: DELIVER_MAX_ATTEMPTS },
      tx,
    );
  }

  /** The notification created by an earlier identical request, or 409 if the body differs. */
  private async findReplay(
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<string | undefined> {
    // Expired keys are free to reuse.
    await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, tenantId),
          eq(idempotencyKeys.key, key),
          lte(idempotencyKeys.expiresAt, new Date()),
        ),
      );
    const [existing] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, tenantId),
          eq(idempotencyKeys.key, key),
          gt(idempotencyKeys.expiresAt, new Date()),
        ),
      );
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new ConflictException("Idempotency-Key was already used with a different request body");
    }
    return existing.notificationId;
  }
}

function hashRequest(request: { request: NotifyRequest; source: Producer["source"] }): string {
  return sha256Hex(stableStringify(request));
}

/** JSON with sorted object keys, so equal requests hash equally regardless of key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
