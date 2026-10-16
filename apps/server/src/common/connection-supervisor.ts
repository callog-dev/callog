import type { Logger } from "@nestjs/common";

/** How often workers re-read connections changed by other processes (or that failed). */
const RECONCILE_INTERVAL_MS = 60_000;

export interface SupervisedHandle {
  stop(): void | Promise<void>;
  /** True when the handle gave up (e.g. a failed start) and should be started again. */
  failed?(): boolean;
}

/**
 * Keeps one running handle per tenant (a Telegram poll loop, a Slack socket) in step with
 * the stored connections: bots are connected through the API, possibly in another
 * process, so workers re-read the connections periodically. A connection is identified by
 * a fingerprint (its sealed token): a new one restarts the handle, none stops it.
 */
export class ConnectionSupervisor<C, H extends SupervisedHandle> {
  private readonly running = new Map<string, { fingerprint: string; handle: H }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly spec: {
      list: () => Promise<C[]>;
      tenantOf: (connection: C) => string;
      /** undefined: nothing to run for this connection. */
      fingerprint: (connection: C) => string | undefined;
      /** Must not block: long-running work continues in the background. */
      start: (connection: C) => H;
    },
  ) {}

  /** Reconciles now and then periodically (not awaited: a slow start must not block boot). */
  watch(): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  async reconcile(): Promise<void> {
    try {
      const connections = await this.spec.list();
      const connected = new Set<string>();
      for (const connection of connections) {
        const tenantId = this.spec.tenantOf(connection);
        connected.add(tenantId);
        const current = this.running.get(tenantId);
        const fingerprint = this.spec.fingerprint(connection);
        if (current?.fingerprint !== fingerprint || current?.handle.failed?.()) {
          await this.restart(connection);
        }
      }
      for (const tenantId of this.running.keys()) {
        if (!connected.has(tenantId)) await this.stop(tenantId);
      }
    } catch (err) {
      this.logger.warn(`Connections reconcile failed: ${String(err)}`);
    }
  }

  /** (Re)starts the handle of one connection, e.g. right after it was connected here. */
  async restart(connection: C): Promise<void> {
    const tenantId = this.spec.tenantOf(connection);
    await this.stop(tenantId);
    const fingerprint = this.spec.fingerprint(connection);
    if (fingerprint === undefined) return;
    this.running.set(tenantId, { fingerprint, handle: this.spec.start(connection) });
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer);
    for (const tenantId of [...this.running.keys()]) await this.stop(tenantId);
  }

  private async stop(tenantId: string): Promise<void> {
    const current = this.running.get(tenantId);
    this.running.delete(tenantId);
    await current?.handle.stop();
  }
}
