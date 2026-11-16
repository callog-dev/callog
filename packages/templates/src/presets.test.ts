import { readFileSync } from "node:fs";
import path from "node:path";
import { parseConfigTree, type Route } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { renderGroupKey, renderRouteRecipients } from "./recipients";
import { renderSlack } from "./slack";
import { renderTelegram } from "./telegram";

const PRESETS = path.resolve(__dirname, "../../../templates/presets");

function preset(file: string): Route {
  const id = file.replace(/\.yaml$/, "");
  const parsed = parseConfigTree({
    "places.yaml": 'places: { alerts: { slack: "#alerts" } }',
    [`routes/${file}`]: readFileSync(path.join(PRESETS, file), "utf8"),
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config.routes[id]!;
}

describe("the Grafana preset", () => {
  const route = preset("grafana-alerts.yaml");
  const firing = route.examples[0]!.data;
  const input = (data: Record<string, unknown>) => ({ data, recipients: [] });

  it("renders a firing group of alerts", () => {
    const { blocks, text } = renderSlack(route, input(firing)).message;
    expect(text).toBe("🔥 Firing: HighCPU");
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "section", "actions"]);
    expect(blocks[1]).toMatchObject({ text: { text: "CPU is above 90% for 5 minutes" } });
    expect(blocks[2]).toMatchObject({
      fields: [{ text: "*Alerts*\n2" }, { text: "*Where*\ndb-1, db-2" }],
    });
    expect(blocks[3]).toMatchObject({
      elements: [{ url: "https://grafana.example.com/alerting/grafana/abc/view" }],
    });
    expect(renderTelegram(route, input(firing)).message.text).toContain(
      "<b>🔥 Firing: HighCPU</b>",
    );
  });

  it("turns the same message to resolved: the group key does not change", () => {
    const resolved = { ...firing, status: "resolved" };
    expect(renderSlack(route, input(resolved)).message.text).toBe("✅ Resolved: HighCPU");
    expect(renderGroupKey(route, resolved)).toBe(renderGroupKey(route, firing));
    expect(renderGroupKey(route, firing)).toBe('{}:{alertname="HighCPU"} 2026-01-01T10:00:00Z');
  });

  it("opens a new message when the group fires again: an edit would notify nobody", () => {
    const alerts = (firing.alerts as Record<string, unknown>[]).map((alert) => ({
      ...alert,
      startsAt: "2026-01-01T15:30:00Z",
    }));
    expect(renderGroupKey(route, { ...firing, alerts })).not.toBe(renderGroupKey(route, firing));
  });

  it("takes extra recipients from the callog_notify label", () => {
    expect(renderRouteRecipients(route, firing)).toEqual(["team:sre"]);
    const labelled = { ...firing, commonLabels: { callog_notify: "github:octocat place:oncall" } };
    expect(renderRouteRecipients(route, labelled)).toEqual(["github:octocat", "place:oncall"]);
  });

  it("still renders the least Grafana can send", () => {
    const bare = { status: "firing", alerts: [], groupKey: "{}:{}" };
    const { blocks, text } = renderSlack(route, input(bare)).message;
    expect(text).toBe("🔥 Firing: Grafana alert");
    expect(blocks[1]).toMatchObject({ text: { text: "No summary" } });
    expect(renderRouteRecipients(route, bare)).toEqual([]);
  });
});
