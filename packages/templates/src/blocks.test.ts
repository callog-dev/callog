import { routeSchema, type Route } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { renderBlocks } from "./blocks";
import type { MarkdownTarget } from "./markdown";

const route = (input: Record<string, unknown>): Route =>
  routeSchema.parse({
    id: "r",
    allowed_sources: { api_keys: ["ci"] },
    destinations: [{ slack: "#x" }],
    ...input,
  });

const everyBlock = [
  { header: "Failed on {{ data.branch }}" },
  { text: "**{{ data.branch }}** broke" },
  { fields: [{ label: "Suite", value: "`{{ data.suite }}`" }] },
  { context: "run {{ data.n }}" },
  { divider: true },
  { actions: [{ text: "Open", url: "https://ci.example/{{ data.n }}" }] },
];
const input = { data: { branch: "<main>", suite: "e2e", n: 7 }, recipients: [] };

const html: MarkdownTarget = {
  escape: (text) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  bold: (inner) => `<b>${inner}</b>`,
  italic: (inner) => `<i>${inner}</i>`,
  strike: (inner) => `<s>${inner}</s>`,
  code: (inner) => `<code>${inner}</code>`,
  link: (text, url) => `<a href="${url}">${text}</a>`,
};

/** A channel with no formatting at all: the least a message can degrade to. */
const plainText: MarkdownTarget = {
  escape: (text) => text,
  bold: (inner) => inner,
  italic: (inner) => inner,
  strike: (inner) => inner,
  code: (inner) => inner,
  link: (text, url) => `${text} (${url})`,
};

describe("renderBlocks", () => {
  it("hands native blocks over as they are", () => {
    const { message } = renderBlocks(route({ template: everyBlock }), input, {
      target: html,
      native: ["header", "text", "fields", "context", "divider", "actions"],
    });
    expect(message).toEqual([
      { type: "header", text: "Failed on <main>" },
      { type: "text", text: "<b>&lt;main&gt;</b> broke" },
      { type: "fields", fields: [{ label: "Suite", value: "<code>e2e</code>" }] },
      { type: "context", text: "run 7" },
      { type: "divider" },
      { type: "actions", actions: [{ text: "Open", url: "https://ci.example/7" }] },
    ]);
  });

  it("turns the blocks a channel cannot draw into its own markup", () => {
    const { message } = renderBlocks(route({ template: everyBlock }), input, {
      target: html,
      native: ["text"],
    });
    expect(message.map((block) => block.type)).toEqual(Array(6).fill("text"));
    expect(message.map((block) => "text" in block && block.text)).toEqual([
      "<b>Failed on &lt;main&gt;</b>",
      "<b>&lt;main&gt;</b> broke",
      "<b>Suite:</b> <code>e2e</code>",
      "<i>run 7</i>",
      "———",
      '<a href="https://ci.example/7">Open</a>',
    ]);
  });

  it("degrades to plain text for a channel without formatting", () => {
    const { message } = renderBlocks(route({ template: everyBlock }), input, {
      target: plainText,
      native: ["text"],
    });
    expect(message.map((block) => "text" in block && block.text)).toEqual([
      "Failed on <main>",
      "<main> broke",
      "Suite: e2e",
      "run 7",
      "———",
      "Open (https://ci.example/7)",
    ]);
  });

  it("keeps data from ending a link early", () => {
    const template = [{ actions: [{ text: "Open", url: "https://x.dev/{{ data.q }}" }] }];
    const { message } = renderBlocks(
      route({ template }),
      { data: { q: 'a"b|c>d' }, recipients: [] },
      { target: html, native: ["text"] },
    );
    expect(message).toEqual([
      { type: "text", text: '<a href="https://x.dev/a%22b%7Cc%3Ed">Open</a>' },
    ]);
  });

  it("renders no more fields and actions than the channel shows", () => {
    const template = [
      { fields: [1, 2, 3].map((n) => ({ label: `F${n}`, value: "v" })) },
      { actions: ["https://a.dev", "{{ data.bad }}"].map((url) => ({ text: "Go", url })) },
    ];
    const { message } = renderBlocks(
      route({ template }),
      { data: { bad: "javascript:alert(1)" }, recipients: [] },
      { target: html, native: ["fields", "actions"], limits: { fields: 2, actions: 1 } },
    );
    expect(message).toEqual([
      {
        type: "fields",
        fields: [
          { label: "F1", value: "v" },
          { label: "F2", value: "v" },
        ],
      },
      { type: "actions", actions: [{ text: "Go", url: "https://a.dev" }] },
    ]);
  });

  it("writes a mention in a plain string as the name", () => {
    const { message, unmapped } = renderBlocks(
      route({ template: [{ header: "For {{ recipients | mention }}" }] }),
      { data: {}, recipients: ["github:octocat"] },
      { target: html, native: ["header"], mention: () => "<@U1>" },
    );
    expect(message).toEqual([{ type: "header", text: "For octocat" }]);
    expect(unmapped).toEqual([]);
  });
});
