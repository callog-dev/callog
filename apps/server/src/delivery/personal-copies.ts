import { Injectable } from "@nestjs/common";
import { parseRef, type Config, type Ref, type Route } from "@callog/config-schema";
import type { ChannelId } from "../channels/channel";
import { ChannelRegistry } from "../channels/channel-registry";
import type { TraceNote } from "../db/schema";
import { PreferencesService } from "../identity/preferences.service";
import { RecipientResolver } from "../routing/recipient-resolver";
import {
  defaultTargets,
  personalTarget,
  targetKey,
  teamTargets,
  type Target,
} from "./destinations";

/** A copy for one person: where it goes first, and where it goes if that fails for good. */
export interface PersonalCopy extends Target {
  /** Whom it is for: `person:<id>`, or the ref of someone Callog does not know. */
  forPeople: Ref[];
  fallbacks: Target[];
}

export interface PersonalPlan {
  copies: PersonalCopy[];
  /** Who gets no copy of their own, and why. */
  notes: TraceNote[];
  /** Recipients with no account in any channel, and why (for teams). */
  unreached: Ref[];
  reasons: Map<Ref, string>;
}

interface Recipient {
  accounts: Map<ChannelId, string>;
  /** Teams the sender named that this person is in. */
  teams: Set<string>;
}

/**
 * Personal copies for routes with `dm: true`. Every recipient (teams expanded) gets one,
 * unless they muted the route: in the channel they prefer, then in another one they have,
 * then in a room of the team they were named through, then in the route's default place.
 * A team with nobody to write to is posted to its room.
 */
@Injectable()
export class PersonalCopies {
  constructor(
    private readonly channels: ChannelRegistry,
    private readonly resolver: RecipientResolver,
    private readonly preferences: PreferencesService,
  ) {}

  async plan(
    tenantId: string,
    route: Route,
    config: Config,
    recipients: Ref[],
  ): Promise<PersonalPlan> {
    const channelIds = this.channels.all().map((c) => c.id);
    const people = new Map<string, Recipient>();
    let unreached = new Set(recipients);
    /** Recipients that are a person Callog knows, or a team with such people. */
    const known = new Set<Ref>();
    const reasons = new Map<Ref, string>();
    for (const channelId of channelIds) {
      const resolution = await this.resolver.resolve(tenantId, config, recipients, channelId);
      unreached = new Set(resolution.unmapped.filter((ref) => unreached.has(ref)));
      for (const [ref, reason] of resolution.reasons) reasons.set(ref, reason);
      for (const { ref, persons } of resolution.refs) {
        const { kind, value } = parseRef(ref);
        for (const person of persons) {
          known.add(ref);
          const recipient = people.get(person.personId) ?? {
            accounts: new Map(),
            teams: new Set(),
          };
          if (person.target) recipient.accounts.set(channelId, person.target.externalId);
          if (kind === "team") recipient.teams.add(value);
          people.set(person.personId, recipient);
        }
      }
    }

    const teamRooms = (slug: string) => teamTargets(config, slug, this.channels);
    const lastResort = defaultTargets(route, config, this.channels);
    const prefs = await this.preferences.getMany([...people.keys()]);
    const muted = await this.preferences.mutedAmong([...people.keys()], route);
    const copies = new CopySet();
    const notes: TraceNote[] = [];
    for (const [personId, { accounts, teams }] of people) {
      const recipient: Ref = `person:${personId}`;
      const pref = prefs.get(personId)!;
      if (muted.has(personId)) {
        notes.push({ recipient, note: "muted" });
        continue;
      }
      const direct = [...new Set([pref.dmChannel, ...channelIds])]
        .filter((id) => accounts.has(id))
        .map((id) => personalTarget(id, accounts.get(id)!));
      if (direct.length === 0) notes.push({ recipient, note: "no_account" });
      copies.add([...direct, ...[...teams].flatMap(teamRooms), ...lastResort], [recipient]);
    }
    for (const ref of unreached) {
      if (known.has(ref)) continue;
      const { kind, value } = parseRef(ref);
      // A team's room is for the team; anyone else has to be named.
      if (kind === "team") {
        notes.push({ recipient: ref, note: "empty_team", detail: reasons.get(ref) });
        copies.add([...teamRooms(value), ...lastResort], []);
      } else {
        notes.push({ recipient: ref, note: "unknown" });
        copies.add(lastResort, [ref]);
      }
    }
    return { copies: copies.list(), notes, unreached: [...unreached], reasons };
  }
}

/** One copy per target: people who end up in the same room share its message. */
class CopySet {
  private readonly copies = new Map<string, PersonalCopy>();

  /** `chain` is where to try, in order; an empty one reaches nobody and adds nothing. */
  add(chain: Target[], forPeople: Ref[]): void {
    const [first, ...fallbacks] = chain;
    if (!first) return;
    const key = targetKey(first);
    const existing = this.copies.get(key);
    if (existing) existing.forPeople.push(...forPeople);
    else this.copies.set(key, { ...first, forPeople: [...forPeople], fallbacks });
  }

  list(): PersonalCopy[] {
    return [...this.copies.values()];
  }
}
