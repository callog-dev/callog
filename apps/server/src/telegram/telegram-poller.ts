import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConnectionSupervisor } from "../common/connection-supervisor";
import { ENV, type Env } from "../config/env";
import { TelegramApiError } from "./telegram-api";
import {
  TelegramConnectionsService,
  type TelegramConnection,
} from "./telegram-connections.service";
import { TelegramUpdates } from "./telegram-updates";

const POLL_TIMEOUT_S = 25;
const ERROR_BACKOFF_MS = 5_000;
/** 409: another process polls the same bot (or a webhook is set). */
const CONFLICT_BACKOFF_MS = 30_000;

/**
 * Long-polls `getUpdates` for every connected bot: works behind NAT without a
 * public URL. Runs only in worker processes; Telegram allows one poller per bot token, so
 * run a single worker replica (or switch to webhooks when scaling out).
 */
@Injectable()
export class TelegramPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramPoller.name);
  private readonly loops = new ConnectionSupervisor(this.logger, {
    list: () => this.connections.listAll(),
    tenantOf: (connection: TelegramConnection) => connection.tenantId,
    fingerprint: (connection) => connection.botTokenEncrypted,
    start: (connection) => {
      const controller = new AbortController();
      this.logger.log(
        `Polling Telegram @${connection.botUsername} for tenant ${connection.tenantId}`,
      );
      void this.loop(connection, controller.signal);
      return { stop: () => controller.abort() };
    },
  });

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly connections: TelegramConnectionsService,
    private readonly updates: TelegramUpdates,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.ROLE === "api") return;
    this.connections.onConnected((connection) => void this.start(connection));
    this.loops.watch();
  }

  onApplicationShutdown(): Promise<void> {
    return this.loops.stopAll();
  }

  reconcile(): Promise<void> {
    return this.loops.reconcile();
  }

  /** (Re)starts polling for a tenant's bot. */
  start(connection: TelegramConnection): Promise<void> {
    return this.loops.restart(connection);
  }

  private async loop(connection: TelegramConnection, signal: AbortSignal): Promise<void> {
    const { tenantId, botUsername } = connection;
    let offset = connection.lastUpdateId + 1;
    while (!signal.aborted) {
      try {
        const api = await this.connections.api(tenantId);
        if (!api) return;
        const batch = await api.getUpdates(offset, POLL_TIMEOUT_S, signal);
        for (const update of batch) {
          // Restarted (another bot connected): its offset was reset and must not be overwritten.
          if (signal.aborted) return;
          try {
            await this.updates.handle(tenantId, api, update, botUsername);
          } catch (err) {
            this.logger.warn(`Telegram update ${update.update_id} failed: ${String(err)}`);
          }
          offset = update.update_id + 1;
        }
        if (batch.length > 0 && !signal.aborted) {
          await this.connections.saveOffset(tenantId, offset - 1);
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramApiError && err.code === 401) {
          // Revoked token: retrying cannot help. The loop stays registered with this token,
          // so it restarts only once the bot is connected again (a new token).
          this.logger.error(
            `Telegram bot token of tenant ${tenantId} was rejected; reconnect the bot to resume`,
          );
          return;
        }
        const conflict = err instanceof TelegramApiError && err.code === 409;
        this.logger.warn(`Telegram polling for tenant ${tenantId} failed: ${String(err)}`);
        await sleep(conflict ? CONFLICT_BACKOFF_MS : ERROR_BACKOFF_MS, signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
