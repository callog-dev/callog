import { ownValue, type Config, type Place, type Route, type Team } from "@callog/config-schema";
import type { ChannelId, Destination } from "../channels/channel";
import type { ChannelRegistry } from "../channels/channel-registry";
import type { DeliveryTarget } from "../db/schema";

export type Target = DeliveryTarget;

/** Two targets with the same key are the same room, or the same person's chat. */
export function targetKey(target: { provider: string; destination: string }): string {
  return `${target.provider}\n${target.destination}`;
}

/** A personal copy is stored as `dm:<the person's account id in the channel>`. */
const DM_PREFIX = "dm:";

export function personalTarget(provider: ChannelId, accountId: string): Target {
  return { provider, destination: `${DM_PREFIX}${accountId}` };
}

/** Reads back the `destination` column of a delivery. */
export function parseDestination(destination: string): Destination {
  return destination.startsWith(DM_PREFIX)
    ? { kind: "person", id: destination.slice(DM_PREFIX.length) }
    : { kind: "place", id: destination };
}

/**
 * Concrete places a notification is posted to: the route's destinations (rooms, named
 * places and each team's channels) plus the places its recipients name, de-duplicated.
 */
export function routeTargets(
  route: Route,
  config: Config,
  channels: ChannelRegistry,
  recipientPlaces: string[] = [],
): Target[] {
  const targets = new TargetSet(channels);
  for (const name of recipientPlaces) targets.addPlace(ownValue(config.places, name));
  for (const d of route.destinations) {
    if ("place" in d) targets.addPlace(ownValue(config.places, d.place));
    else if (!("team" in d)) targets.addPlace(d);
    else {
      targets.addTeam(ownValue(config.teams, d.team));
    }
  }
  return targets.list();
}

/** Where a route without destinations posts a notification that reached nobody else. */
export function defaultTargets(route: Route, config: Config, channels: ChannelRegistry): Target[] {
  const targets = new TargetSet(channels);
  if (route.default_place) targets.addPlace(ownValue(config.places, route.default_place));
  return targets.list();
}

/** The rooms of a team, where what could not reach one of its people goes instead. */
export function teamTargets(config: Config, slug: string, channels: ChannelRegistry): Target[] {
  const targets = new TargetSet(channels);
  targets.addTeam(ownValue(config.teams, slug));
  return targets.list();
}

/** Targets in the order they were added, each room once per channel. */
class TargetSet {
  private readonly targets = new Map<string, Target>();

  constructor(private readonly channels: ChannelRegistry) {}

  add(provider: ChannelId, room: string): void {
    const destination = this.channels.get(provider)?.normalizePlace?.(room) ?? room;
    const target = { provider, destination };
    this.targets.set(targetKey(target), target);
  }

  addPlace(place: Place | undefined): void {
    if (!place) return;
    if ("slack" in place) this.add("slack", place.slack);
    else this.add("telegram", place.telegram);
  }

  addTeam(team: Team | undefined): void {
    if (team?.slack_channel) this.add("slack", team.slack_channel);
    if (team?.telegram_chat) this.add("telegram", team.telegram_chat);
  }

  list(): Target[] {
    return [...this.targets.values()];
  }
}
