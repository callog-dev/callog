import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { DB, type Db, type DbOrTx, type Tx } from "../db/db";
import { TenantAdminsService } from "./tenant-admins.service";
import {
  CONFIDENCE_LEVELS,
  identities,
  persons,
  type Confidence,
  type IdentitySource,
  type Provider,
} from "../db/schema";

export interface AccountInput {
  provider: Provider;
  externalId: string;
  handle?: string;
  source: IdentitySource;
  confidence: Confidence;
}

export interface LinkInput {
  displayName: string;
  /** In priority order: when accounts belong to different persons, the first one's person wins. */
  accounts: AccountInput[];
  /** Overwrite the person's display name (authoritative sources such as the Slack directory). */
  updateDisplayName?: boolean;
}

export interface AccountConflict {
  account: AccountInput;
  ownerPersonId: string;
}

export interface LinkResult {
  personId: string;
  created: boolean;
  addedAccounts: AccountInput[];
  conflicts: AccountConflict[];
}

export type AttachOutcome =
  | { kind: "added" | "unchanged" }
  | { kind: "moved"; fromPersonId: string }
  | { kind: "conflict"; ownerPersonId: string };

type IdentityRow = typeof identities.$inferSelect;

const rank = (c: Confidence) => CONFIDENCE_LEVELS.length - CONFIDENCE_LEVELS.indexOf(c);

/** Normalises external ids so the same account always maps to one identity row. */
export function normalizeExternalId(provider: Provider, externalId: string): string {
  return provider === "email" || provider === "github" ? externalId.toLowerCase() : externalId;
}

/**
 * Person/Identity bookkeeping. Links accounts that are known to belong
 * to one human; never merges two existing persons automatically.
 */
@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly admins: TenantAdminsService,
  ) {}

  async linkAccounts(tenantId: string, input: LinkInput): Promise<LinkResult> {
    const accounts = input.accounts.map((a) => ({
      ...a,
      externalId: normalizeExternalId(a.provider, a.externalId),
    }));

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(identities)
        .where(
          and(
            eq(identities.tenantId, tenantId),
            or(
              ...accounts.map((a) =>
                and(eq(identities.provider, a.provider), eq(identities.externalId, a.externalId)),
              ),
            ),
          ),
        );
      const find = (a: AccountInput) =>
        existing.find((e) => e.provider === a.provider && e.externalId === a.externalId);

      // The first account that already has an owner decides the person.
      let personId = accounts.map(find).find(Boolean)?.personId;
      let created = false;
      if (!personId) {
        const [person] = await tx
          .insert(persons)
          .values({ tenantId, displayName: input.displayName })
          .returning({ id: persons.id });
        personId = person!.id;
        created = true;
      } else if (input.updateDisplayName) {
        await tx
          .update(persons)
          .set({ displayName: input.displayName })
          .where(eq(persons.id, personId));
      }

      const addedAccounts: AccountInput[] = [];
      const conflicts: AccountConflict[] = [];
      for (const account of accounts) {
        const outcome = await this.upsertAccount(tx, tenantId, personId, account, find(account));
        if (outcome.kind === "added" || outcome.kind === "moved") addedAccounts.push(account);
        if (outcome.kind === "conflict")
          conflicts.push({ account, ownerPersonId: outcome.ownerPersonId });
      }
      return { personId, created, addedAccounts, conflicts };
    });
  }

  /**
   * Links one account to a known person. Unlike `linkAccounts` it never creates a person:
   * used by sources that only enrich people anchored elsewhere (GitHub sync).
   */
  async attachAccount(
    tenantId: string,
    personId: string,
    input: AccountInput,
    {
      executor = this.db,
      takeFromOthers = true,
    }: {
      /** Run inside the caller's transaction. */
      executor?: DbOrTx;
      /**
       * false: an account owned by another person is a conflict even for stronger
       * evidence — self-service links must not take accounts away.
       */
      takeFromOthers?: boolean;
    } = {},
  ): Promise<AttachOutcome> {
    const account = { ...input, externalId: normalizeExternalId(input.provider, input.externalId) };
    return executor.transaction(async (tx) => {
      const row = await findIdentity(tx, tenantId, account);
      return this.upsertAccount(tx, tenantId, personId, account, row, takeFromOthers);
    });
  }

  /**
   * Conflict rules: an account owned by another person moves only when the
   * new evidence is strictly stronger; equal or weaker evidence is reported, never applied.
   */
  private async upsertAccount(
    tx: Tx,
    tenantId: string,
    personId: string,
    account: AccountInput,
    row: IdentityRow | undefined,
    takeFromOthers = true,
  ): Promise<AttachOutcome> {
    if (!row) {
      const inserted = await tx
        .insert(identities)
        .values({ tenantId, personId, ...account, lastSeenAt: new Date() })
        .onConflictDoNothing({
          target: [identities.tenantId, identities.provider, identities.externalId],
        })
        .returning({ id: identities.id });
      if (inserted.length > 0) return { kind: "added" };
      // A concurrent sync linked it in the meantime: apply the usual conflict rules.
      const current = await findIdentity(tx, tenantId, account);
      return this.upsertAccount(tx, tenantId, personId, account, current!, takeFromOthers);
    }
    const stronger = rank(account.confidence) > rank(row.confidence);
    if (row.personId !== personId) {
      if (!stronger || !takeFromOthers) {
        this.logger.warn(
          `Identity ${account.provider}:${account.externalId} belongs to person ${row.personId}, ` +
            `not linking it to ${personId}`,
        );
        return { kind: "conflict", ownerPersonId: row.personId };
      }
      await tx
        .update(identities)
        .set({
          personId,
          handle: account.handle ?? row.handle,
          source: account.source,
          confidence: account.confidence,
          lastSeenAt: new Date(),
        })
        .where(eq(identities.id, row.id));
      this.logger.warn(
        `Identity ${account.provider}:${account.externalId} moved from person ${row.personId} to ` +
          `${personId} (${row.confidence} → ${account.confidence} via ${account.source})`,
      );
      return { kind: "moved", fromPersonId: row.personId };
    }
    await tx
      .update(identities)
      .set({
        handle: account.handle ?? row.handle,
        lastSeenAt: new Date(),
        // Never downgrade: a weaker source must not undo a verified link.
        ...(stronger ? { confidence: account.confidence, source: account.source } : {}),
      })
      .where(eq(identities.id, row.id));
    return { kind: "unchanged" };
  }

  /**
   * Activates or deactivates the person behind an account. Inactive people
   * are never mentioned or messaged; their data is purged after a grace period.
   */
  async setActiveByIdentity(
    tenantId: string,
    provider: Provider,
    externalId: string,
    active: boolean,
  ): Promise<"changed" | "unchanged" | "unknown"> {
    const [identity] = await this.db
      .select({ personId: identities.personId })
      .from(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, provider),
          eq(identities.externalId, normalizeExternalId(provider, externalId)),
        ),
      );
    if (!identity) return "unknown";
    const rows = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(persons)
        .set(
          active
            ? { status: "active", deactivatedAt: null }
            : { status: "inactive", deactivatedAt: new Date() },
        )
        .where(
          and(
            eq(persons.id, identity.personId),
            eq(persons.status, active ? "inactive" : "active"),
          ),
        )
        .returning({ id: persons.id });
      // Someone who left keeps no admin role.
      if (updated.length > 0 && !active) {
        await this.admins.revokeOnDeactivation(tx, tenantId, identity.personId);
      }
      return updated;
    });
    if (rows.length === 0) return "unchanged";
    this.logger.log(
      `Person ${identity.personId} ${active ? "reactivated" : "deactivated"} (${provider}:${externalId})`,
    );
    return "changed";
  }

  /** Forgets one account, e.g. a GitHub user removed from the org. */
  async removeIdentity(tenantId: string, provider: Provider, externalId: string): Promise<boolean> {
    const rows = await this.db
      .delete(identities)
      .where(
        and(
          eq(identities.tenantId, tenantId),
          eq(identities.provider, provider),
          eq(identities.externalId, normalizeExternalId(provider, externalId)),
        ),
      )
      .returning({ id: identities.id });
    return rows.length > 0;
  }
}

async function findIdentity(
  tx: Tx,
  tenantId: string,
  account: AccountInput,
): Promise<IdentityRow | undefined> {
  const [row] = await tx
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.tenantId, tenantId),
        eq(identities.provider, account.provider),
        eq(identities.externalId, account.externalId),
      ),
    );
  return row;
}
