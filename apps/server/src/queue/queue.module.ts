import { Global, Module } from "@nestjs/common";
import { QueueService } from "./queue.service";
import { QueueWorker } from "./queue.worker";

@Global()
@Module({
  providers: [QueueService, QueueWorker],
  exports: [QueueService],
})
export class QueueModule {}
