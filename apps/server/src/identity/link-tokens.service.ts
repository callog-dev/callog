import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../crypto/digest";
import { DB, type Db, type DbOrTx } from "../db/db";
import { linkTokens } from "../db/schema";

export type LinkProvider = "github" | "telegram";
export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface LinkOwner {
  tenantId: string;
  personId: string;
}

/** An account proven by the provider, waiting for the user's confirmation. */
export interface PendingAccount {
  externalId: string;
  handle?: string;
}

@Injectable()
export class LinkTokensService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 43 url-safe chars: fits Telegram's 64-char `start` parameter. */
  async issue(tenantId: string, personId: string, provider: LinkProvider): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(linkTokens).values({
      tenantId,
      personId,
      provider,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS),
    });
    return token;
  }

  /** Marks the token used and returns whom it was issued for; undefined if invalid, used or expired. */
  async consume(
    token: string,
    provider: LinkProvider,
    { tenantId, executor = this.db }: { tenantId?: string; executor?: DbOrTx } = {},
  ): Promise<LinkOwner | undefined> {
    const [row] = await executor
      .update(linkTokens)
      .set({ usedAt: new Date() })
      .where(and(usable(token, provider), tenantId ? eq(linkTokens.tenantId, tenantId) : undefined))
      .returning({ tenantId: linkTokens.tenantId, personId: linkTokens.personId });
    return row;
  }

  /**
   * Remembers the account the provider confirmed, bound to a nonce held by the browser that
   * did the OAuth; the token stays unused until `consumeStaged`. A later stage replaces it.
   */
  async stage(
    token: string,
    provider: LinkProvider,
    account: PendingAccount,
    nonce: string,
  ): Promise<LinkOwner | undefined> {
    const [row] = await this.db
      .update(linkTokens)
      .set({
        pendingExternalId: account.externalId,
        pendingHandle: account.handle ?? null,
        pendingNonceHash: sha256Hex(nonce),
      })
      .where(usable(token, provider))
      .returning({ tenantId: linkTokens.tenantId, personId: linkTokens.personId });
    return row;
  }

  /** Like `consume`, for a staged token, and only from the browser holding its nonce. */
  async consumeStaged(
    token: string,
    provider: LinkProvider,
    nonce: string | undefined,
    { executor = this.db }: { executor?: DbOrTx } = {},
  ): Promise<(LinkOwner & { account: PendingAccount }) | undefined> {
    if (!nonce) return undefined;
    const [row] = await executor
      .update(linkTokens)
      .set({ usedAt: new Date() })
      .where(and(usable(token, provider), eq(linkTokens.pendingNonceHash, sha256Hex(nonce))))
      .returning({
        tenantId: linkTokens.tenantId,
        personId: linkTokens.personId,
        externalId: linkTokens.pendingExternalId,
        handle: linkTokens.pendingHandle,
      });
    if (!row?.externalId) return undefined;
    return {
      tenantId: row.tenantId,
      personId: row.personId,
      account: { externalId: row.externalId, handle: row.handle ?? undefined },
    };
  }
}

/** The token exists for this provider, is unused and not expired. */
function usable(token: string, provider: LinkProvider) {
  return and(
    eq(linkTokens.tokenHash, sha256Hex(token)),
    eq(linkTokens.provider, provider),
    isNull(linkTokens.usedAt),
    gt(linkTokens.expiresAt, new Date()),
  );
}
