import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { DB, type Db, type DbOrTx, type Tx } from "../db/db";
import { persons } from "../db/schema";
import {
  LinkTokensService,
  type LinkOwner,
  type LinkProvider,
  type PendingAccount,
} from "./link-tokens.service";
import { PeopleService } from "./people.service";

export type LinkOutcome =
  | { ok: true; personName: string }
  | { ok: false; reason: "invalid_token" | "taken_by_someone_else" };

/**
 * Completes a self-service link: the one-time token proves which
 * person asked (from Slack); the provider proves the account is theirs. Only then is the
 * identity stored, as `verified` — and never taken from another person: a
 * link URL can be forwarded, so whoever opens it must not acquire someone else's account.
 */
@Injectable()
export class AccountLinkingService {
  private readonly logger = new Logger(AccountLinkingService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: LinkTokensService,
    private readonly people: PeopleService,
  ) {}

  /** Links at once (Telegram: the account is the chat that opened the deep link). */
  async complete(
    provider: LinkProvider,
    token: string,
    account: PendingAccount,
    tenantId?: string,
  ): Promise<LinkOutcome> {
    return this.db.transaction(async (tx) => {
      const owner = await this.tokens.consume(token, provider, { tenantId, executor: tx });
      return owner ? this.attach(tx, owner, provider, account) : invalid();
    });
  }

  /**
   * First half of a GitHub link: remembers the account GitHub confirmed and asks the user
   * to confirm whom it is linked to. Returns the nonce for the confirming browser.
   */
  async stage(
    provider: LinkProvider,
    token: string,
    account: PendingAccount,
  ): Promise<{ ok: true; personName: string; nonce: string } | { ok: false }> {
    const nonce = randomBytes(24).toString("base64url");
    const owner = await this.tokens.stage(token, provider, account, nonce);
    if (!owner) return { ok: false };
    return { ok: true, personName: await this.personName(this.db, owner.personId), nonce };
  }

  /** Second half: the user confirmed in the same browser (it holds the nonce). */
  async confirm(
    provider: LinkProvider,
    token: string,
    nonce: string | undefined,
  ): Promise<LinkOutcome> {
    return this.db.transaction(async (tx) => {
      const staged = await this.tokens.consumeStaged(token, provider, nonce, { executor: tx });
      return staged ? this.attach(tx, staged, provider, staged.account) : invalid();
    });
  }

  private async attach(
    tx: Tx,
    owner: LinkOwner,
    provider: LinkProvider,
    account: PendingAccount,
  ): Promise<LinkOutcome> {
    const outcome = await this.people.attachAccount(
      owner.tenantId,
      owner.personId,
      {
        provider,
        externalId: account.externalId,
        handle: account.handle?.toLowerCase(),
        source: provider === "github" ? "oauth" : "deeplink",
        confidence: "verified",
      },
      { executor: tx, takeFromOthers: false },
    );
    if (outcome.kind === "conflict") {
      this.logger.warn(`${provider}:${account.externalId} is already linked to another person`);
      return { ok: false, reason: "taken_by_someone_else" };
    }
    this.logger.log(`Linked ${provider}:${account.externalId} to person ${owner.personId}`);
    return { ok: true, personName: await this.personName(tx, owner.personId) };
  }

  private async personName(executor: DbOrTx, personId: string): Promise<string> {
    const [person] = await executor
      .select({ displayName: persons.displayName })
      .from(persons)
      .where(eq(persons.id, personId));
    return person?.displayName ?? "you";
  }
}

const invalid = (): LinkOutcome => ({ ok: false, reason: "invalid_token" });
