import {
  PayloadTooLargeException,
  UnprocessableEntityException,
  type RawBodyRequest,
} from "@nestjs/common";
import { recipientSchema, slugSchema } from "@callog/config-schema";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;

/** 413 for a body the producer API will not take. */
export function assertBodySize(req: RawBodyRequest<FastifyRequest>): void {
  const size = req.rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? {}));
  if (size > MAX_BODY_BYTES) {
    throw new PayloadTooLargeException(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
}

/** 422 with the issues of a body that does not parse. */
export function parseNotifyRequest(body: unknown): NotifyRequest {
  const parsed = notifyRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new UnprocessableEntityException({
    message: "Invalid request body",
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
export const MAX_RECIPIENTS = 50;
/** Threads the server opens for a route's `group`; senders cannot name one. */
export const GROUP_THREAD_PREFIX = "group:";

/** Body of `POST /v1/notify`. */
export const notifyRequestSchema = z
  .strictObject({
    route: slugSchema,
    data: z.record(z.string(), z.unknown()).default({}),
    /** People and teams to mention, and places (`place:<name>`) to post to. */
    recipients: z.array(recipientSchema).max(MAX_RECIPIENTS).default([]),
    thread_key: z
      .string()
      .min(1)
      .max(200)
      .refine((key) => !key.startsWith(GROUP_THREAD_PREFIX), {
        message: `must not start with "${GROUP_THREAD_PREFIX}"`,
      })
      .optional(),
    /** Edit the thread's first message instead of posting a new one. */
    update: z.boolean().default(false),
  })
  .refine((r) => !r.update || r.thread_key, {
    message: "update requires thread_key",
    path: ["update"],
  });

export type NotifyRequest = z.infer<typeof notifyRequestSchema>;
