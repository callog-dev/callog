import { refSchema, slugSchema } from "@callog/config-schema";
import { z } from "zod";

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECIPIENTS = 50;

/** Body of `POST /v1/notify`. */
export const notifyRequestSchema = z
  .strictObject({
    route: slugSchema,
    data: z.record(z.string(), z.unknown()).default({}),
    recipients: z
      .array(refSchema(["email", "github", "slack", "telegram", "team", "person"]))
      .max(MAX_RECIPIENTS)
      .default([]),
    thread_key: z.string().min(1).max(200).optional(),
    /** Edit the thread's first message instead of posting a new one. */
    update: z.boolean().default(false),
  })
  .refine((r) => !r.update || r.thread_key, {
    message: "update requires thread_key",
    path: ["update"],
  });

export type NotifyRequest = z.infer<typeof notifyRequestSchema>;
