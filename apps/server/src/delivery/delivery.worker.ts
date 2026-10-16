import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DELIVER_TASK } from "../notifications/notifications.service";
import { QueueService } from "../queue/queue.service";
import { DeliveryService } from "./delivery.service";

@Injectable()
export class DeliveryWorker implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly delivery: DeliveryService,
  ) {}

  onModuleInit(): void {
    this.queue.register(DELIVER_TASK, async (payload, helpers) => {
      await this.delivery.deliver((payload as { notificationId: string }).notificationId, {
        attempt: helpers.job.attempts,
        maxAttempts: helpers.job.max_attempts,
      });
    });
  }
}
