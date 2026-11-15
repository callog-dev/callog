import { parseConfigTree } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../channels/channel-registry";
import { SlackChannel } from "../slack/slack-channel";
import type { SlackSender } from "../slack/slack-sender";
import { defaultTargets, routeTargets } from "./destinations";

const channels = new ChannelRegistry([new SlackChannel({} as SlackSender)]);

const parse = (route: string) => {
  const parsed = parseConfigTree({
    "places.yaml": `
places:
  deploys: { slack: deploys }
  oncall: { telegram: "-100123" }`,
    "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
template: [{ text: hi }]
${route}`,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

describe("routeTargets", () => {
  it("resolves named places, from the route and from recipients", () => {
    const config = parse('destinations: [{ place: deploys }, { slack: "#deploys" }]');
    expect(routeTargets(config.routes.r!, config, channels, ["oncall", "deploys"])).toEqual([
      { provider: "telegram", destination: "-100123" },
      { provider: "slack", destination: "#deploys" },
    ]);
  });

  it("keeps the default place apart from what the route delivers to", () => {
    const config = parse("default_place: oncall");
    const route = config.routes.r!;
    expect(routeTargets(route, config, channels)).toEqual([]);
    expect(defaultTargets(route, config, channels)).toEqual([
      { provider: "telegram", destination: "-100123" },
    ]);
  });

  it("expands teams and de-duplicates channels", () => {
    const parsed = parseConfigTree({
      "teams.yaml": `
teams:
  fe: { slack_channel: "#fe", telegram_chat: fe-chat }
  qa: { slack_channel: fe }`,
      "routes/r.yaml": `
id: r
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#fe" }, { team: fe }, { team: qa }, { slack: C0123456 }]
template: [{ text: hi }]`,
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(routeTargets(parsed.config.routes.r!, parsed.config, channels)).toEqual([
      { provider: "slack", destination: "#fe" },
      { provider: "telegram", destination: "fe-chat" },
      { provider: "slack", destination: "C0123456" },
    ]);
  });
});
