import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/db";
import { deliveries } from "../db/schema";

/** What cancelling does to a notification's deliveries: those not sent yet are cancelled. */
export function cancelPending(executor: DbOrTx, notificationId: string) {
  return executor
    .update(deliveries)
    .set({ status: "cancelled" })
    .where(and(eq(deliveries.notificationId, notificationId), eq(deliveries.status, "pending")))
    .returning({ id: deliveries.id });
}
