import { Injectable, Logger } from "@nestjs/common";
import { IdentityEvents } from "../identity/identity-events";
import { PeopleService, type AccountInput } from "../identity/people.service";
import { SlackConnectionsService } from "./slack-connections.service";

export interface SlackSyncResult {
  users: number;
  deactivated: number;
  reactivated: number;
  createdPersons: number;
  withoutEmail: number;
  conflicts: number;
}

/**
 * Imports the Slack directory: every active human becomes a Person with a verified
 * `slack` identity and, when Slack exposes it, a verified work `email` identity —
 * the anchor for matching other accounts.
 * Users deleted in Slack are deactivated, and reactivated when they return.
 */
@Injectable()
export class SlackUsersSync {
  private readonly logger = new Logger(SlackUsersSync.name);

  constructor(
    private readonly connections: SlackConnectionsService,
    private readonly people: PeopleService,
    private readonly identityEvents: IdentityEvents,
  ) {}

  async sync(tenantId: string): Promise<SlackSyncResult | undefined> {
    const api = await this.connections.api(tenantId);
    if (!api) return undefined;

    const all = (await api.listUsers()).filter((u) => !u.isBot);
    const humans = all.filter((u) => !u.deleted);
    const result: SlackSyncResult = {
      deactivated: 0,
      reactivated: 0,
      users: humans.length,
      createdPersons: 0,
      withoutEmail: 0,
      conflicts: 0,
    };
    for (const user of humans) {
      const accounts: AccountInput[] = [
        {
          provider: "slack",
          externalId: user.id,
          handle: user.name,
          source: "sync",
          confidence: "verified",
        },
      ];
      if (user.email) {
        accounts.push({
          provider: "email",
          externalId: user.email,
          source: "sync",
          confidence: "verified",
        });
      } else {
        result.withoutEmail++;
      }
      const linked = await this.people.linkAccounts(tenantId, {
        displayName: user.realName,
        accounts,
        updateDisplayName: true,
      });
      if (linked.created) result.createdPersons++;
      // Slack is the anchor of being "active": back in Slack → active again.
      if ((await this.people.setActiveByIdentity(tenantId, "slack", user.id, true)) === "changed") {
        result.reactivated++;
      }
      result.conflicts += linked.conflicts.length;
    }
    for (const user of all.filter((u) => u.deleted)) {
      if (
        (await this.people.setActiveByIdentity(tenantId, "slack", user.id, false)) === "changed"
      ) {
        result.deactivated++;
      }
    }
    await this.connections.markSynced(tenantId);
    // New work emails may match more GitHub accounts.
    await this.identityEvents.requestGithubSync(tenantId);
    this.logger.log(`Slack sync for tenant ${tenantId}: ${JSON.stringify(result)}`);
    return result;
  }
}
