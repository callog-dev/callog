import { ownValue, type Config, type Route } from "@callog/config-schema";
import type { ChannelId, Destination } from "../channels/channel";
import type { ChannelRegistry } from "../channels/channel-registry";

export interface Target {
  provider: ChannelId;
  destination: string;
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
 * Concrete places a route delivers to: explicit channels plus each
 * team's channels, de-duplicated.
 */
export function routeTargets(route: Route, config: Config, channels: ChannelRegistry): Target[] {
  const targets = new Map<string, Target>();
  const add = (provider: ChannelId, destination: string) => {
    const normalized = channels.get(provider)?.normalizePlace?.(destination) ?? destination;
    targets.set(`${provider}\n${normalized}`, { provider, destination: normalized });
  };
  for (const d of route.destinations) {
    if ("slack" in d) add("slack", d.slack);
    else if ("telegram" in d) add("telegram", d.telegram);
    else {
      const team = ownValue(config.teams, d.team);
      if (team?.slack_channel) add("slack", team.slack_channel);
      if (team?.telegram_chat) add("telegram", team.telegram_chat);
    }
  }
  return [...targets.values()];
}
