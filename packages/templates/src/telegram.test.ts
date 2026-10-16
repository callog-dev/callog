import { routeSchema, type Route } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { TemplateRenderError } from "./engine";
import { renderTelegram } from "./telegram";

const route = (input: Record<string, unknown>): Route =>
  routeSchema.parse({
    id: "r",
    allowed_sources: { api_keys: ["ci"] },
    destinations: [{ telegram: "-100123" }],
    ...input,
  });

describe("renderTelegram", () => {
  it("renders every block type to HTML with an inline keyboard", () => {
    const r = route({
      template: [
        { header: "🔴 Failed on {{ data.branch }}" },
        {
          text: "**b** _i_ ~~s~~ `c` [run](https://x.dev/{{ data.n }}) {{ recipients | mention }}",
        },
        { fields: [{ label: "Branch", value: "`{{ data.branch }}`" }] },
        { context: "ctx" },
        { divider: true },
        { buttons: [{ text: "Open", url: "https://x.dev/{{ data.n }}" }] },
      ],
    });
    const { message, unmapped } = renderTelegram(
      r,
      { data: { branch: "main", n: 1 }, recipients: ["github:bob", "github:ghost"] },
      {
        mention: (ref) => (ref === "github:bob" ? '<a href="tg://user?id=42">Bob</a>' : undefined),
      },
    );
    expect(message.text).toBe(
      [
        "<b>🔴 Failed on main</b>",
        '<b>b</b> <i>i</i> <s>s</s> <code>c</code> <a href="https://x.dev/1">run</a> <a href="tg://user?id=42">Bob</a>, ghost',
        "<b>Branch:</b> <code>main</code>",
        "<i>ctx</i>",
        "———",
      ].join("\n\n"),
    );
    expect(message.buttons).toEqual([[{ text: "Open", url: "https://x.dev/1" }]]);
    expect(unmapped).toEqual(["github:ghost"]);
  });

  it("escapes data and literal text", () => {
    const r = route({ template: [{ header: "<{{ data.x }}>" }, { text: "a < b {{ data.x }}" }] });
    const { message } = renderTelegram(r, { data: { x: "<b>&" }, recipients: [] });
    expect(message.text).toBe("<b>&lt;&lt;b&gt;&amp;&gt;</b>\n\na &lt; b &lt;b&gt;&amp;");
  });

  it("keeps data in link URLs inside the href attribute", () => {
    const r = route({ template: [{ text: "[a]({{ data.u }}) [b]({{ data.v }})" }] });
    const { message } = renderTelegram(r, {
      data: { u: 'https://a.dev/"onclick="x', v: "javascript:alert(1)" },
      recipients: [],
    });
    expect(message.text).toBe('<a href="https://a.dev/%22onclick=%22x">a</a> b');
  });

  it("refuses routes with only slack_blocks", () => {
    const r = route({ slack_blocks: [{ type: "divider" }] });
    expect(() => renderTelegram(r, { data: {}, recipients: [] })).toThrow(TemplateRenderError);
  });

  it("drops trailing blocks instead of cutting HTML when the text is too long", () => {
    const r = route({ template: [{ text: "{{ data.a }}" }, { text: "{{ data.b }}" }] });
    const { message } = renderTelegram(r, {
      data: { a: "x".repeat(3000), b: "y".repeat(3000) },
      recipients: [],
    });
    expect(message.text).toBe(`${"x".repeat(3000)}\n…`);
  });

  it("cuts a single over-long block as plain text instead of sending only the ellipsis", () => {
    const r = route({ template: [{ text: "**log:** {{ data.log }}" }] });
    const { message } = renderTelegram(r, { data: { log: "a&b ".repeat(2000) }, recipients: [] });
    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.text.startsWith("log: a&amp;b a&amp;b")).toBe(true);
    expect(message.text).not.toMatch(/<|&[a-z]*\n…$/);
    expect(message.text.endsWith("\n…")).toBe(true);
  });

  it("groups buttons three per row", () => {
    const buttons = Array.from({ length: 4 }, (_, i) => ({ text: `B${i}`, url: "https://x.dev" }));
    const { message } = renderTelegram(route({ template: [{ buttons }] }), {
      data: {},
      recipients: [],
    });
    expect(message.buttons.map((row) => row.length)).toEqual([3, 1]);
  });
});
