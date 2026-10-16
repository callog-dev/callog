import { parseConfigTree } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { routeTargets } from "./destinations";

describe("routeTargets", () => {
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
    expect(routeTargets(parsed.config.routes.r!, parsed.config)).toEqual([
      { provider: "slack", destination: "#fe" },
      { provider: "telegram", destination: "fe-chat" },
      { provider: "slack", destination: "C0123456" },
    ]);
  });
});
