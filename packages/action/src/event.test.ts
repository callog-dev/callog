import { describe, expect, it } from "vitest";
import { eventAuthor } from "./event";

describe("eventAuthor", () => {
  it.each([
    ["push", { head_commit: { author: { username: "alice" } } }, "alice"],
    ["pull_request", { pull_request: { user: { login: "bob" } } }, "bob"],
    ["workflow_run", { workflow_run: { actor: { login: "carol" } } }, "carol"],
    ["schedule", {}, "actor"],
  ])("%s", (name, event, expected) => {
    expect(eventAuthor(name, event, "actor")).toBe(expected);
  });

  it("ignores bots", () => {
    expect(eventAuthor("push", {}, "dependabot[bot]")).toBeUndefined();
  });
});
