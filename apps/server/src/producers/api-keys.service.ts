import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../crypto/digest";
import { DB, type Db } from "../db/db";
import { apiKeys } from "../db/schema";

const API_KEY_PREFIX = "ntf_";

/** Key names are referenced from routes' `allowed_sources.api_keys`. */
export const apiKeyNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _");

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Named API keys for backend producers. Only a SHA-256 of the key is stored:
 * keys are 256-bit random, so no slow KDF is needed.
 */
@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Returns the plaintext key exactly once. */
  async create(tenantId: string, name: string): Promise<{ key: string; info: ApiKeyInfo }> {
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const rows = await this.db
      .insert(apiKeys)
      .values({
        tenantId,
        name,
        prefix: key.slice(0, API_KEY_PREFIX.length + 6),
        keyHash: sha256Hex(key),
      })
      .onConflictDoNothing({ target: [apiKeys.tenantId, apiKeys.name] })
      .returning();
    if (rows.length === 0) throw new ConflictException(`API key "${name}" already exists`);
    return { key, info: toInfo(rows[0]!) };
  }

  async list(tenantId: string): Promise<ApiKeyInfo[]> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
    return rows.map(toInfo);
  }

  async revoke(tenantId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, name), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  /** The active key matching the plaintext, or undefined. Touches `last_used_at`. */
  async verify(key: string): Promise<{ id: string; tenantId: string; name: string } | undefined> {
    if (!key.startsWith(API_KEY_PREFIX)) return undefined;
    const [row] = await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.keyHash, sha256Hex(key)), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, tenantId: apiKeys.tenantId, name: apiKeys.name });
    return row;
  }
}

function toInfo(row: typeof apiKeys.$inferSelect): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
