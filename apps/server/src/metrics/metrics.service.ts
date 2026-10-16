import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { DB, type Db } from "../db/db";

/**
 * Prometheus metrics. One registry per app instance, so several apps in
 * one process (tests) do not clash on the global registry.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly notificationsReceived = new Counter({
    name: "callog_notifications_received_total",
    help: "Notifications accepted by the API (idempotent replays excluded)",
    labelNames: ["route"] as const,
    registers: [this.registry],
  });

  readonly deliveries = new Counter({
    name: "callog_deliveries_total",
    help: "Deliveries that reached a final state",
    labelNames: ["provider", "status"] as const,
    registers: [this.registry],
  });

  readonly deliveryLatency = new Histogram({
    name: "callog_delivery_latency_seconds",
    help: "Time from accepting a notification to the provider confirming the message",
    labelNames: ["provider"] as const,
    buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 300, 1800],
    registers: [this.registry],
  });

  readonly unmappedRecipients = new Counter({
    name: "callog_unmapped_recipients_total",
    help: "Recipients rendered as plain text because no identity matched",
    labelNames: ["provider"] as const,
    registers: [this.registry],
  });

  readonly configReloads = new Counter({
    name: "callog_config_reload_total",
    help: "Config repo loads by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  constructor(@Inject(DB) private readonly db: Db) {
    collectDefaultMetrics({ register: this.registry });
    const database = this.db;
    new Gauge({
      name: "callog_queue_jobs",
      help: "Jobs in the queue by state",
      labelNames: ["state"] as const,
      registers: [this.registry],
      async collect() {
        const { rows } = await database.execute<{
          ready: number;
          scheduled: number;
          locked: number;
          failed: number;
        }>(sql`
          select
            count(*) filter (
              where locked_at is null and attempts < max_attempts and run_at <= now()
            )::int as ready,
            -- Waiting for a future run_at: delayed jobs and retries in backoff.
            count(*) filter (
              where locked_at is null and attempts < max_attempts and run_at > now()
            )::int as scheduled,
            count(*) filter (where locked_at is not null)::int as locked,
            count(*) filter (where attempts >= max_attempts)::int as failed
          from graphile_worker.jobs`);
        const row = rows[0]!; // an aggregate without GROUP BY: always one row
        this.set({ state: "ready" }, row.ready);
        this.set({ state: "scheduled" }, row.scheduled);
        this.set({ state: "locked" }, row.locked);
        this.set({ state: "failed" }, row.failed);
      },
    });
  }
}
