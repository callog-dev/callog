import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/** Validates a request body with zod; 400 with a readable message on failure. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}
