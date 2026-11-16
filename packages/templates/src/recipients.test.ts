import { routeSchema, type Route } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { TemplateRenderError } from "./engine";
import { renderRouteRecipients } from "./recipients";

const route = (recipients: string[]): Route =>
  routeSchema.parse({
    id: "r",
    allowed_sources: { api_keys: ["ci"] },
    destinations: [{ slack: "#x" }],
    template: [{ text: "hi" }],
    recipients,
  });

describe("renderRouteRecipients", () => {
  it("renders people, teams and places from the data, each once", () => {
    const r = route([
      "github:{{ data.author }}",
      "{% for login in data.reviewers %}github:{{ login }}, {% endfor %}",
      "team:sre",
      "place:{{ data.env }}-deploys",
    ]);
    const data = { author: "octocat", reviewers: ["hubot", "octocat"], env: "prod" };
    expect(renderRouteRecipients(r, data)).toEqual([
      "github:octocat",
      "github:hubot",
      "team:sre",
      "place:prod-deploys",
    ]);
  });

  it("leaves out what does not render to a recipient", () => {
    const r = route(["github:{{ data.author }}", "{{ data.note }}", "place:{{ data.place }}"]);
    expect(renderRouteRecipients(r, { note: "see the run", place: "Not A Slug" })).toEqual([]);
  });

  it("reports a broken expression at its place in the route", () => {
    const r = route(["team:sre", "{{ data.author | nope }}"]);
    expect(() => renderRouteRecipients(r, {})).toThrow(TemplateRenderError);
    expect(() => renderRouteRecipients(r, {})).toThrow(/^recipients\.1: /);
  });
});
