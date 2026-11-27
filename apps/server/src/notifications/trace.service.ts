import { Inject, Injectable } from "@nestjs/common";
import { parseRef, type Ref } from "@callog/config-schema";
import { and, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { deliveries, notifications, persons, type TraceNote } from "../db/schema";

type Notification = typeof notifications.$inferSelect;

/** Someone the trace talks about: the ref, and the person's name when Callog knows them. */
export interface TracedRecipient {
  ref: Ref;
  name: string;
}

export interface Trace {
  /** Set when the route groups repeats: `joined` means this one edited an earlier message. */
  group: { key: string; joined: boolean } | null;
  /** Why a recipient got no message of their own, or no mention. */
  notes: (Omit<TraceNote, "recipient"> & { recipient: TracedRecipient })[];
  deliveries: {
    id: string;
    provider: string;
    destination: string;
    status: "pending" | "sent" | "failed";
    attempts: number;
    lastError: string | null;
    sentAt: Date | null;
    /** The people a personal copy, or the post that replaced it, is for. */
    for: TracedRecipient[];
    /** The delivery that took over when this one could not be delivered. */
    fallbackTo: string | null;
  }[];
}

/**
 * Answers "why did I not get it": what happened to a notification on its way to each
 * recipient — where it was sent, what took over when that failed, and who was left out.
 */
@Injectable()
export class TraceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async of(notification: Notification): Promise<Trace> {
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.notificationId, notification.id))
      .orderBy(deliveries.createdAt);
    const name = await this.names(notification.tenantId, [
      ...notification.trace.map((note) => note.recipient),
      ...rows.flatMap((row) => row.forPeople),
    ]);
    return {
      group: notification.groupKey
        ? { key: notification.groupKey, joined: notification.update }
        : null,
      notes: notification.trace.map((note) => ({ ...note, recipient: name(note.recipient) })),
      deliveries: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        destination: row.destination,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        sentAt: row.sentAt,
        for: row.forPeople.map(name),
        fallbackTo: row.fallbackTo,
      })),
    };
  }

  /** `person:<id>` refs become names; any other ref is shown by its visible part. */
  async names(tenantId: string, refs: Ref[]): Promise<(ref: Ref) => TracedRecipient> {
    const ids = [
      ...new Set(refs.map(parseRef).flatMap((r) => (r.kind === "person" ? [r.value] : []))),
    ];
    const known = ids.length
      ? await this.db
          .select({ id: persons.id, name: persons.displayName })
          .from(persons)
          .where(and(eq(persons.tenantId, tenantId), inArray(persons.id, ids)))
      : [];
    const nameById = new Map(known.map((p) => [p.id, p.name]));
    return (ref) => {
      const { kind, value } = parseRef(ref);
      return { ref, name: kind === "person" ? (nameById.get(value) ?? value) : value };
    };
  }
}
