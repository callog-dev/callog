import { ownValue, type Config, type Route } from "@callog/config-schema";
import type { TargetProvider } from "../routing/recipient-resolver";
import { SLACK_CHANNEL_ID } from "../slack/slack-sender";

export interface Target {
  provider: TargetProvider;
  destination: string;
}

/**
 * Concrete places a route delivers to: explicit channels plus each
 * team's channels, de-duplicated.
 */
export function routeTargets(route: Route, config: Config): Target[] {
  const targets = new Map<string, Target>();
  const add = (provider: Target["provider"], destination: string) => {
    const normalized = provider === "slack" ? normalizeSlackChannel(destination) : destination;
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

/** `fe-alerts` and `#fe-alerts` are the same channel; ids are kept as is. */
function normalizeSlackChannel(channel: string): string {
  return SLACK_CHANNEL_ID.test(channel) || channel.startsWith("#") ? channel : `#${channel}`;
}
