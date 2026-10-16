import { Inject, Injectable } from "@nestjs/common";
import { eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db";
import { personPreferences } from "../db/schema";

export type DmChannel = "slack" | "telegram";

export interface Preferences {
  dmChannel: DmChannel;
  mutedRoutes: string[];
}

const DEFAULTS: Preferences = { dmChannel: "slack", mutedRoutes: [] };

@Injectable()
export class PreferencesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(personId: string): Promise<Preferences> {
    return (await this.getMany([personId])).get(personId)!;
  }

  /** Preferences for many people at once (defaults for those without a row). */
  async getMany(personIds: string[]): Promise<Map<string, Preferences>> {
    const rows = personIds.length
      ? await this.db
          .select()
          .from(personPreferences)
          .where(inArray(personPreferences.personId, personIds))
      : [];
    return new Map(
      personIds.map((id) => {
        const row = rows.find((r) => r.personId === id);
        return [
          id,
          row ? { dmChannel: row.dmChannel, mutedRoutes: row.mutedRoutes } : { ...DEFAULTS },
        ];
      }),
    );
  }

  async setDmChannel(tenantId: string, personId: string, dmChannel: DmChannel): Promise<void> {
    await this.db
      .insert(personPreferences)
      .values({ tenantId, personId, dmChannel })
      .onConflictDoUpdate({ target: personPreferences.personId, set: { dmChannel } });
  }

  async mute(tenantId: string, personId: string, routeId: string): Promise<void> {
    await this.db
      .insert(personPreferences)
      .values({ tenantId, personId, mutedRoutes: [routeId] })
      .onConflictDoUpdate({
        target: personPreferences.personId,
        set: {
          mutedRoutes: sql`array(select distinct unnest(${personPreferences.mutedRoutes} || array[${routeId}]::text[]))`,
        },
      });
  }

  async unmute(personId: string, routeId: string): Promise<void> {
    await this.db
      .update(personPreferences)
      .set({ mutedRoutes: sql`array_remove(${personPreferences.mutedRoutes}, ${routeId})` })
      .where(eq(personPreferences.personId, personId));
  }
}
