import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { mintSecret, sha256Hex } from "../crypto/digest";
import { DB, type Db } from "../db/db";
import { hooks } from "../db/schema";

const HOOK_TOKEN_PREFIX = "hk_";

export interface HookInfo {
  id: string;
  name: string;
  routeId: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Inbound webhooks: a URL with a secret token that posts whatever JSON it receives to one
 * route. For systems that cannot sign a request or set a header. Only a SHA-256 of the
 * token is stored: tokens are 256-bit random, so no slow KDF is needed.
 */
@Injectable()
export class HooksService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Returns the plaintext token exactly once. */
  async create(
    tenantId: string,
    name: string,
    routeId: string,
  ): Promise<{ token: string; info: HookInfo }> {
    const { secret: token, display, hash } = mintSecret(HOOK_TOKEN_PREFIX);
    const rows = await this.db
      .insert(hooks)
      .values({ tenantId, name, routeId, prefix: display, tokenHash: hash })
      .onConflictDoNothing({ target: [hooks.tenantId, hooks.name] })
      .returning();
    if (rows.length === 0) throw new ConflictException(`Hook "${name}" already exists`);
    return { token, info: toInfo(rows[0]!) };
  }

  async list(tenantId: string): Promise<HookInfo[]> {
    const rows = await this.db.select().from(hooks).where(eq(hooks.tenantId, tenantId));
    return rows.map(toInfo);
  }

  async revoke(tenantId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .update(hooks)
      .set({ revokedAt: new Date() })
      .where(and(eq(hooks.tenantId, tenantId), eq(hooks.name, name), isNull(hooks.revokedAt)))
      .returning({ id: hooks.id });
    return rows.length > 0;
  }

  /** The active hook matching the plaintext token, or undefined. Touches `last_used_at`. */
  async verify(
    token: string,
  ): Promise<{ id: string; tenantId: string; name: string; routeId: string } | undefined> {
    if (!token.startsWith(HOOK_TOKEN_PREFIX)) return undefined;
    const [row] = await this.db
      .update(hooks)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(hooks.tokenHash, sha256Hex(token)), isNull(hooks.revokedAt)))
      .returning({
        id: hooks.id,
        tenantId: hooks.tenantId,
        name: hooks.name,
        routeId: hooks.routeId,
      });
    return row;
  }
}

function toInfo(row: typeof hooks.$inferSelect): HookInfo {
  return {
    id: row.id,
    name: row.name,
    routeId: row.routeId,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
