import { describe, expect, it } from "vitest";
import { parseConfigTree, type ConfigTree, type ParseResult } from "./parse";
import { loadFixture } from "./test-utils";

const valid = () => loadFixture("valid");

function errorsOf(result: ParseResult) {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

const minimalRoute = (id: string, extra = "") => `
id: ${id}
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#x" }]
template: [{ text: hi }]
${extra}`;

describe("parseConfigTree", () => {
  it("parses the valid fixture and applies defaults", () => {
    const result = parseConfigTree(valid());
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));

    const route = result.config.routes["fe-e2e-failed"]!;
    expect(route.mentions).toBe("recipients");
    expect(route.dm).toBe(false);
    expect(route.allowed_sources.api_keys).toEqual([]);
    expect(route.examples[0]?.recipients).toEqual(["github:octocat"]);
    expect(result.config.teams.frontend?.members_from).toEqual({ github_team: "frontend" });
    expect(result.config.config.defaults.unmapped_recipient).toBe("plain_text");
    expect(result.warnings).toEqual([]);
  });

  it("treats an empty repo as a valid empty config", () => {
    const result = parseConfigTree({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.routes).toEqual({});
  });

  it("reports YAML syntax errors with the file", () => {
    const errors = errorsOf(parseConfigTree({ "teams.yaml": "teams: [unclosed" }));
    expect(errors[0]).toMatchObject({ file: "teams.yaml", path: [] });
    expect(errors[0]?.message).toMatch(/^YAML:/);
  });

  it("rejects unknown keys with a precise path", () => {
    const tree: ConfigTree = {
      "teams.yaml": "teams:\n  fe:\n    slack_chanel: '#fe'\n    telegram_chat: '-1'\n",
    };
    const errors = errorsOf(parseConfigTree(tree));
    expect(errors).toEqual([
      expect.objectContaining({ file: "teams.yaml", path: ["teams", "fe"] }),
    ]);
    expect(errors[0]?.message).toContain("slack_chanel");
  });

  it("requires the route id to match the file name", () => {
    const errors = errorsOf(parseConfigTree({ "routes/a.yaml": minimalRoute("b") }));
    expect(errors).toEqual([
      { file: "routes/a.yaml", path: ["id"], message: 'must match the file name "a"' },
    ]);
  });

  it("rejects the same route defined as .yaml and .yml", () => {
    const errors = errorsOf(
      parseConfigTree({ "routes/a.yaml": minimalRoute("a"), "routes/a.yml": minimalRoute("a") }),
    );
    expect(errors[0]?.message).toContain("duplicate route id");
  });

  it("compiles route schemas with the same $id independently", () => {
    const schema = 'schema: { $id: "https://acme.dev/data", type: object, required: [n] }';
    const tree = {
      "routes/a.yaml": minimalRoute("a", schema),
      "routes/b.yaml": minimalRoute("b", schema),
    };
    expect(parseConfigTree(tree).ok).toBe(true);
    // A reload of the same config (and the API compiling it again) must not collide either.
    expect(parseConfigTree(tree).ok).toBe(true);
  });

  it("does not mistake Object.prototype members for routes or teams", () => {
    const tree = { "routes/constructor.yaml": minimalRoute("constructor") };
    expect(parseConfigTree(tree).ok).toBe(true);
    const route = minimalRoute("a").replace('{ slack: "#x" }', "{ team: constructor }");
    const errors = errorsOf(parseConfigTree({ "routes/a.yaml": route }));
    expect(errors[0]?.message).toBe('unknown team "constructor" (not defined in teams.yaml)');
  });

  it("requires at least one allowed source", () => {
    const route = `
id: a
allowed_sources: {}
destinations: [{ slack: "#x" }]
template: [{ text: hi }]`;
    const errors = errorsOf(parseConfigTree({ "routes/a.yaml": route }));
    expect(errors[0]).toMatchObject({ file: "routes/a.yaml", path: ["allowed_sources"] });
  });

  it("requires template or slack_blocks", () => {
    const route = `
id: a
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#x" }]`;
    const errors = errorsOf(parseConfigTree({ "routes/a.yaml": route }));
    expect(errors[0]).toMatchObject({ path: ["template"] });
  });

  it("rejects references to unknown teams", () => {
    const tree = valid();
    tree["routes/fe-e2e-failed.yaml"] = tree["routes/fe-e2e-failed.yaml"]!.replace(
      "team: frontend",
      "team: backend",
    );
    const errors = errorsOf(parseConfigTree(tree));
    expect(errors).toEqual([
      {
        file: "routes/fe-e2e-failed.yaml",
        path: ["destinations", 1, "team"],
        message: 'unknown team "backend" (not defined in teams.yaml)',
      },
    ]);
  });

  it("requires a neutral template when the route reaches Telegram", () => {
    const route = `
id: a
allowed_sources: { api_keys: [ci] }
destinations: [{ telegram: chat }]
slack_blocks: [{ type: section }]`;
    const errors = errorsOf(parseConfigTree({ "routes/a.yaml": route }));
    expect(errors[0]?.message).toContain("Telegram destination requires template");
  });

  it("rejects malformed recipient refs in examples", () => {
    const errors = errorsOf(
      parseConfigTree({
        "routes/a.yaml": minimalRoute("a", "examples: [{ recipients: [octocat] }]"),
      }),
    );
    expect(errors[0]).toMatchObject({ path: ["examples", 0, "recipients", 0] });
  });

  describe("no people in the repo", () => {
    it("rejects people.yaml and says where account links live now", () => {
      const result = parseConfigTree({ "people.yaml": "people: []" });
      expect(result.warnings).toEqual([]);
      const errors = errorsOf(result);
      expect(errors).toEqual([
        { file: "people.yaml", path: [], message: expect.stringContaining("/manage") },
      ]);
      expect(errors[0]!.message).toMatch(/^removed:/);
    });

    it("rejects config.yaml admins with a hint, alongside ordinary unknown keys", () => {
      const errors = errorsOf(
        parseConfigTree({ "config.yaml": "admins: [github:alice]\nretention: 3" }),
      );
      expect(errors).toEqual([
        { file: "config.yaml", path: ["admins"], message: expect.stringContaining("/manage") },
        { file: "config.yaml", path: [], message: 'Unrecognized key: "retention"' },
      ]);
    });

    it("rejects teams.*.members with a hint pointing at members_from", () => {
      const tree = {
        "teams.yaml": "teams:\n  fe:\n    slack_channel: '#fe'\n    members: [github:a]\n",
      };
      const errors = errorsOf(parseConfigTree(tree));
      expect(errors).toEqual([
        {
          file: "teams.yaml",
          path: ["teams", "fe", "members"],
          message: expect.stringContaining("members_from"),
        },
      ]);
    });

    it("rejects a team that is neither an address nor a group of people", () => {
      const errors = errorsOf(parseConfigTree({ "teams.yaml": "teams:\n  fe: {}\n" }));
      expect(errors).toEqual([
        expect.objectContaining({ file: "teams.yaml", path: ["teams", "fe"] }),
      ]);
      expect(errors[0]!.message).toContain("members_from");
      const empty = errorsOf(
        parseConfigTree({ "teams.yaml": "teams:\n  fe: { members_from: {} }\n" }),
      );
      expect(empty[0]).toMatchObject({ path: ["teams", "fe", "members_from"] });
    });

    it("still accepts person refs in route examples", () => {
      const tree = {
        "routes/a.yaml": minimalRoute(
          "a",
          "examples: [{ recipients: [email:a@x.com, person:p1] }]",
        ),
      };
      expect(parseConfigTree(tree).ok).toBe(true);
    });
  });

  it("warns about unknown yaml files but ignores other and dot-directory files", () => {
    const tree = { ...valid(), "extra.yaml": "a: 1", ".github/workflows/ci.yml": "on: push" };
    const result = parseConfigTree(tree);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      { file: "extra.yaml", path: [], message: "unknown config file, ignored" },
    ]);
  });
});

describe("route data schema", () => {
  const route = (schema: string, examples = "") => `
id: a
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#x" }]
template: [{ text: hi }]
schema: ${schema}
${examples}`;

  it("rejects schemas that are not valid JSON Schema", () => {
    const result = parseConfigTree({ "routes/a.yaml": route("{ type: strng }") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ file: "routes/a.yaml", path: ["schema"] });
      expect(result.errors[0]!.message).toContain("not a valid JSON Schema");
    }
  });

  it("checks examples against the schema", () => {
    const result = parseConfigTree({
      "routes/a.yaml": route(
        "{ type: object, required: [branch], properties: { url: { type: string, format: uri } } }",
        'examples: [{ data: { url: "x" } }]',
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.path.join("."), e.message])).toEqual([
        ["examples.0.data", "must have required property 'branch'"],
        ["examples.0.data.url", 'must match format "uri"'],
      ]);
    }
  });
});
