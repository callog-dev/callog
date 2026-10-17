import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ENV, type Env } from "../config/env";
import { sha256Hex } from "../crypto/digest";
import { DB, type Db } from "../db/db";
import { identities, persons, tenants, webSessions, USABLE_CONFIDENCE } from "../db/schema";

export const SESSION_COOKIE = "callog_session";
export const LOGIN_STATE_COOKIE = "callog_login_state";
export const SESSION_TTL_S = 7 * 24 * 3600;

export interface Session {
  tenantId: string;
  /** Null for an org owner whose GitHub account is not linked to a person yet. */
  personId: string | null;
  /** Set when `personId` is null: the owner's GitHub login. */
  githubLogin: string | null;
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Cookies are Secure whenever the public URL is https. */
  get secureCookies(): boolean {
    return this.env.PUBLIC_URL?.startsWith("https://") ?? false;
  }

  async create(session: Session): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(webSessions).values({
      ...session,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
    });
    return token;
  }

  /** A valid session of an active person in an active tenant, or undefined. */
  async resolve(token: string | undefined): Promise<Session | undefined> {
    if (!token) return undefined;
    const [row] = await this.db
      .select({
        tenantId: webSessions.tenantId,
        personId: webSessions.personId,
        githubLogin: webSessions.githubLogin,
      })
      .from(webSessions)
      .leftJoin(persons, eq(persons.id, webSessions.personId))
      .innerJoin(tenants, eq(tenants.id, webSessions.tenantId))
      .where(
        and(
          eq(webSessions.tokenHash, sha256Hex(token)),
          gt(webSessions.expiresAt, new Date()),
          or(isNull(webSessions.personId), eq(persons.status, "active")),
          eq(tenants.status, "active"),
        ),
      );
    return row;
  }

  async destroy(token: string | undefined): Promise<void> {
    if (token) await this.db.delete(webSessions).where(eq(webSessions.tokenHash, sha256Hex(token)));
  }

  /**
   * The person a GitHub account logs in as: a usable (verified/high) github identity of an
   * active person. A GitHub user in several organizations gets the one linked first.
   */
  async personForGithubUser(
    githubUserId: number,
  ): Promise<{ tenantId: string; personId: string } | undefined> {
    const [row] = await this.db
      .select({ tenantId: identities.tenantId, personId: identities.personId })
      .from(identities)
      .innerJoin(persons, eq(persons.id, identities.personId))
      .innerJoin(tenants, eq(tenants.id, identities.tenantId))
      .where(
        and(
          eq(tenants.status, "active"),
          eq(identities.provider, "github"),
          eq(identities.externalId, String(githubUserId)),
          inArray(identities.confidence, [...USABLE_CONFIDENCE]),
          eq(persons.status, "active"),
        ),
      )
      .orderBy(asc(identities.createdAt))
      .limit(1);
    return row;
  }
}
