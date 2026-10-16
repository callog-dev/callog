import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ownValue } from "@callog/config-schema";
import { and, eq, gt, lte } from "drizzle-orm";
import { sha256Hex } from "../crypto/digest";
import { DB, type Db } from "../db/db";
import { deliveries, idempotencyKeys, notifications } from "../db/schema";
import { ProducerAuthService, type Producer } from "../producers/producer-auth.service";
import { QueueService } from "../queue/queue.service";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { MetricsService } from "../metrics/metrics.service";
import { DataValidator } from "./data-validator";
import type { NotifyRequest } from "./notify-request";

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

/** Rolls back the insert transaction when another request already holds the idempotency key. */
class IdempotencyRace extends Error {}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly configs: TenantConfigService,
    private readonly auth: ProducerAuthService,
    private readonly dataValidator: DataValidator,
    private readonly queue: QueueService,
    private readonly metrics: MetricsService,
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
    const route = ownValue(active.config.routes, request.route);
    if (!route) throw new NotFoundException(`Route "${request.route}" not found`);
    this.auth.assertAllowed(route, producer);

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

    try {
      const notificationId = await this.db.transaction(async (tx) => {
        const [notification] = await tx
          .insert(notifications)
          .values({
            tenantId: producer.tenantId,
            routeId: route.id,
            configVersionId: active.versionId,
            source: producer.source,
            data: request.data,
            recipients: request.recipients,
            threadKey: request.thread_key,
            update: request.update,
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

        await this.queue.enqueue(
          DELIVER_TASK,
          { notificationId: id },
          {
            // Strict order within a thread.
            queueName: threadQueueName(producer.tenantId, request.thread_key),
            maxAttempts: DELIVER_MAX_ATTEMPTS,
          },
          tx,
        );
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
        provider: d.provider,
        destination: d.destination,
        status: d.status,
        attempts: d.attempts,
        last_error: d.lastError,
        sent_at: d.sentAt,
      })),
    };
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
