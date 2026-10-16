import { parseConfigTree, routeSchema, type Route } from "@callog/config-schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateRenderError } from "./engine";
import { renderSlack } from "./slack";
import { validateConfigTree, validateRouteTemplates } from "./validate";

const route = (input: Record<string, unknown>): Route =>
  routeSchema.parse({
    id: "r",
    allowed_sources: { api_keys: ["ci"] },
    destinations: [{ slack: "#x" }],
    ...input,
  });

const slackIds: Record<string, string> = { "github:octocat": "<@U123>" };
const mention = (ref: string) => slackIds[ref];

describe("renderSlack", () => {
  it("renders the design example route", () => {
    const file = path.resolve(
      __dirname,
      "../../config-schema/fixtures/valid/routes/fe-e2e-failed.yaml",
    );
    // Parse the route alone: drop the team destination, which needs teams.yaml.
    const yaml = readFileSync(file, "utf8").replace("  - team: frontend\n", "");
    const result = parseConfigTree({ "routes/fe-e2e-failed.yaml": yaml });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const r = result.config.routes["fe-e2e-failed"]!;

    const { message, unmapped } = renderSlack(r, r.examples[0]!, { mention });

    expect(unmapped).toEqual([]);
    expect(message).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "text": {
              "emoji": true,
              "text": "🔴 e2e failed on main",
              "type": "plain_text",
            },
            "type": "header",
          },
          {
            "text": {
              "text": "Failed tests: *3*. Author: <@U123>",
              "type": "mrkdwn",
            },
            "type": "section",
          },
          {
            "elements": [
              {
                "text": {
                  "emoji": true,
                  "text": "Open run",
                  "type": "plain_text",
                },
                "type": "button",
                "url": "https://github.com/company/fe-e2e/actions/runs/1",
              },
            ],
            "type": "actions",
          },
        ],
        "text": "🔴 e2e failed on main",
      }
    `);
  });

  it("renders every neutral block type", () => {
    const r = route({
      template: [
        { header: "H {{ data.n }}" },
        { text: "**b** _i_ ~~s~~ `c*d` [link](https://x.dev/{{ data.n }})" },
        { fields: [{ label: "Branch", value: "`{{ data.branch }}`" }] },
        { context: "ctx" },
        { divider: true },
      ],
    });
    const { message } = renderSlack(r, { data: { n: 1, branch: "main" }, recipients: [] });
    expect(message.blocks).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "emoji": true,
            "text": "H 1",
            "type": "plain_text",
          },
          "type": "header",
        },
        {
          "text": {
            "text": "*b* _i_ ~s~ \`c*d\` <https://x.dev/1|link>",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "fields": [
            {
              "text": "*Branch*
      \`main\`",
              "type": "mrkdwn",
            },
          ],
          "type": "section",
        },
        {
          "elements": [
            {
              "text": "ctx",
              "type": "mrkdwn",
            },
          ],
          "type": "context",
        },
        {
          "type": "divider",
        },
      ]
    `);
  });

  it("escapes data so it cannot inject mentions, links or markdown", () => {
    const r = route({ template: [{ text: "Branch: {{ data.branch }}" }] });
    const { message } = renderSlack(r, {
      data: { branch: "<!channel> **x** [a](https://evil) & <@U1>" },
      recipients: [],
    });
    expect(message.blocks[0]).toMatchObject({
      text: { text: "Branch: &lt;!channel&gt; **x** [a](https://evil) &amp; &lt;@U1&gt;" },
    });
  });

  it("escapes header data in the fallback text, which Slack parses as mrkdwn", () => {
    const r = route({ template: [{ header: "{{ data.title }}" }] });
    const { message } = renderSlack(r, { data: { title: "<!channel> & co" }, recipients: [] });
    expect(message.blocks[0]).toMatchObject({ text: { text: "<!channel> & co" } });
    expect(message.text).toBe("&lt;!channel&gt; &amp; co");
  });

  it("keeps data in link URLs from turning into mentions or other links", () => {
    const r = route({ template: [{ text: "[PR]({{ data.u }}) [x](https://x.dev/{{ data.q }})" }] });
    const { message } = renderSlack(r, { data: { u: "!channel", q: "a|b" }, recipients: [] });
    expect(message.blocks[0]).toMatchObject({ text: { text: "PR <https://x.dev/a%7Cb|x>" } });
  });

  it("escapes literal template text", () => {
    const r = route({ template: [{ text: "a < b & c > d" }] });
    const { message } = renderSlack(r, { data: {}, recipients: [] });
    expect(message.blocks[0]).toMatchObject({ text: { text: "a &lt; b &amp; c &gt; d" } });
  });

  it("falls back to plain text for unmapped recipients and reports them", () => {
    const r = route({ template: [{ text: "{{ recipients | mention }}" }] });
    const { message, unmapped } = renderSlack(
      r,
      { data: {}, recipients: ["github:octocat", "github:<ghost>"] },
      { mention },
    );
    expect(message.blocks[0]).toMatchObject({ text: { text: "<@U123>, &lt;ghost&gt;" } });
    expect(unmapped).toEqual(["github:<ghost>"]);
  });

  it("mentions each account once when it is reached directly and via a team", () => {
    const r = route({ template: [{ text: "{{ recipients | mention }}" }] });
    const teams: Record<string, string[]> = {
      "github:bob": ["<@UBOB>"],
      "team:frontend": ["<@UALICE>", "<@UBOB>"],
    };
    const { message } = renderSlack(
      r,
      { data: {}, recipients: ["github:bob", "github:ghost", "team:frontend", "github:ghost"] },
      { mention: (ref) => teams[ref] },
    );
    expect(message.blocks[0]).toMatchObject({ text: { text: "<@UBOB>, ghost, <@UALICE>" } });
  });

  it("does not mention anyone when the route has mentions: none", () => {
    const r = route({ mentions: "none", template: [{ text: "{{ recipients | mention }}" }] });
    const { message } = renderSlack(r, { data: {}, recipients: ["github:octocat"] }, { mention });
    expect(message.blocks[0]).toMatchObject({ text: { text: "octocat" } });
  });

  it("applies Liquid with escaping to raw slack_blocks", () => {
    const r = route({
      slack_blocks: [{ type: "section", text: { type: "mrkdwn", text: "*{{ data.x }}*" } }],
    });
    const { message } = renderSlack(r, { data: { x: "<b>" }, recipients: [] });
    expect(message.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*&lt;b&gt;*" } },
    ]);
  });

  it("rejects non-http button URLs", () => {
    const r = route({ template: [{ buttons: [{ text: "Go", url: "{{ data.u }}" }] }] });
    expect(() => renderSlack(r, { data: { u: "javascript:alert(1)" }, recipients: [] })).toThrow(
      TemplateRenderError,
    );
  });

  it("truncates to Block Kit limits", () => {
    const r = route({ template: [{ header: "{{ data.s }}" }] });
    const { message } = renderSlack(r, { data: { s: "x".repeat(500) }, recipients: [] });
    const text = (message.blocks[0] as { text: { text: string } }).text.text;
    expect(text).toHaveLength(150);
    expect(text.endsWith("…")).toBe(true);
  });

  describe("sandbox", () => {
    it("disables partials", () => {
      const r = route({ template: [{ text: "{% include 'secrets' %}" }] });
      expect(() => renderSlack(r, { data: {}, recipients: [] })).toThrow(/not supported/);
    });

    it("rejects unknown filters", () => {
      const r = route({ template: [{ text: "{{ data.x | nope }}" }] });
      expect(() => renderSlack(r, { data: {}, recipients: [] })).toThrow(TemplateRenderError);
    });

    it("stops runaway loops", () => {
      const r = route({
        template: [{ text: "{% for i in (1..100000000) %}{{ i }}{% endfor %}" }],
      });
      expect(() => renderSlack(r, { data: {}, recipients: [] })).toThrow(TemplateRenderError);
    });

    it("does not expose prototype properties", () => {
      const r = route({ template: [{ text: "[{{ data.constructor }}]" }] });
      const { message } = renderSlack(r, { data: {}, recipients: [] });
      expect(message.blocks[0]).toMatchObject({ text: { text: "[]" } });
    });
  });
});

describe("validateRouteTemplates", () => {
  it("reports render errors per example with the block path", () => {
    const r = route({
      template: [{ text: "ok" }, { buttons: [{ text: "Go", url: "{{ data.u }}" }] }],
      examples: [{ data: { u: "https://ok.dev" } }, { data: { u: "nope" } }],
    });
    expect(validateRouteTemplates(r)).toEqual([
      {
        path: ["template", 1, "buttons", 0, "url"],
        message: 'example 1: rendered URL must be http(s), got "nope"',
      },
    ]);
  });

  it("returns no issues for a valid route", () => {
    expect(validateRouteTemplates(route({ template: [{ text: "hi {{ data.x }}" }] }))).toEqual([]);
  });
});

describe("validateConfigTree", () => {
  it("adds template errors with the route file to the config checks", () => {
    const result = validateConfigTree({
      "routes/a.yml": `
id: a
allowed_sources: { api_keys: [ci] }
destinations: [{ slack: "#x" }]
template: [{ text: "{{ data.x | nope }}" }]`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          file: "routes/a.yml",
          path: ["template", 0, "text"],
          message: expect.stringContaining("nope"),
        },
      ]);
    }
  });

  it("passes a valid tree through", () => {
    expect(validateConfigTree({}).ok).toBe(true);
  });
});
