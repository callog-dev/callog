import { Injectable, Logger } from "@nestjs/common";

export type WebhookHandler = (payload: unknown) => Promise<void>;

/**
 * Routes verified GitHub webhook deliveries to handlers. Feature modules
 * register handlers in `onModuleInit` (e.g. tenants: `installation`, config loader: `push`).
 */
@Injectable()
export class GithubWebhooksService {
  private readonly logger = new Logger(GithubWebhooksService.name);
  private readonly handlers = new Map<string, WebhookHandler[]>();

  on(event: string, handler: WebhookHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  /** Returns false when nobody handles this event. */
  async dispatch(event: string, payload: unknown, deliveryId: string): Promise<boolean> {
    const handlers = this.handlers.get(event) ?? [];
    if (handlers.length === 0) {
      this.logger.debug(`Ignoring "${event}" delivery ${deliveryId}`);
      return false;
    }
    for (const handler of handlers) await handler(payload);
    return true;
  }
}
