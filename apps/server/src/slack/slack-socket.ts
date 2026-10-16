import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { ConnectionSupervisor } from "../common/connection-supervisor";
import { ENV, type Env } from "../config/env";
import { SlackCommands } from "./slack-commands";
import { SlackConnectionsService, type SlackConnection } from "./slack-connections.service";
import { SlackEvents } from "./slack-events";

export type SlackSocketClient = Pick<SocketModeClient, "on" | "start" | "disconnect">;
export type SlackSocketFactory = (appToken: string) => SlackSocketClient;
export const SLACK_SOCKET_FACTORY = Symbol("SLACK_SOCKET_FACTORY");

export const createSlackSocket: SlackSocketFactory = (appToken) =>
  new SocketModeClient({ appToken, logLevel: LogLevel.WARN });

/**
 * Receives `/notify` over Slack Socket Mode (outbound WebSocket): no public URL needed,
 * same reasoning as Telegram long polling. Runs in worker processes; a client
 * whose start failed (network, Slack 5xx) is started again by the next reconcile.
 */
@Injectable()
export class SlackSocketRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SlackSocketRunner.name);
  private readonly sockets = new ConnectionSupervisor(this.logger, {
    list: () => this.connections.listAll(),
    tenantOf: (connection: SlackConnection) => connection.tenantId,
    fingerprint: (connection) => connection.appTokenEncrypted ?? undefined,
    start: (connection) => this.open(connection),
  });

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SLACK_SOCKET_FACTORY) private readonly createClient: SlackSocketFactory,
    private readonly connections: SlackConnectionsService,
    private readonly commands: SlackCommands,
    private readonly events: SlackEvents,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.ROLE === "api") return;
    this.connections.onConnected((connection) => void this.sockets.restart(connection));
    this.sockets.watch();
  }

  onApplicationShutdown(): Promise<void> {
    return this.sockets.stopAll();
  }

  reconcile(): Promise<void> {
    return this.sockets.reconcile();
  }

  private open(connection: SlackConnection) {
    const client = this.createClient(this.connections.appToken(connection)!);
    // One Slack app can be installed in several workspaces (tenants), and Slack spreads
    // its events over all of the app's sockets: route each by its workspace.
    const tenantOf = async (body: { team_id?: string }) =>
      body.team_id === connection.teamId
        ? connection.tenantId
        : body.team_id && (await this.connections.findByTeam(body.team_id))?.tenantId;
    client.on("slash_commands", async ({ body, ack }) => {
      const tenantId = await tenantOf(body);
      if (!tenantId) {
        await ack({ response_type: "ephemeral", text: "This workspace is not connected." });
        return;
      }
      const text = await this.commands
        .handle(tenantId, { userId: body.user_id, text: body.text ?? "" })
        .catch((err: unknown) => {
          this.logger.error(`/notify failed: ${String(err)}`);
          return "Something went wrong, please try again.";
        });
      await ack({ response_type: "ephemeral", text });
    });
    // Profile changes and deactivations: re-sync the directory (throttled job).
    client.on("user_change", async ({ body, ack }) => {
      await ack();
      const tenantId = await tenantOf(body);
      if (tenantId) await this.events.requestSync(tenantId, { throttled: true });
    });
    client.on("error", (err: unknown) => {
      this.logger.warn(`Slack Socket Mode error for tenant ${connection.tenantId}: ${String(err)}`);
    });

    let failed = false;
    client.start().then(
      () =>
        this.logger.log(
          `Slack Socket Mode connected for ${connection.teamName} (tenant ${connection.tenantId})`,
        ),
      (err: unknown) => {
        failed = true;
        this.logger.warn(
          `Slack Socket Mode failed for tenant ${connection.tenantId}, will retry: ${String(err)}`,
        );
      },
    );
    return {
      stop: () => client.disconnect().catch(() => undefined),
      failed: () => failed,
    };
  }
}
