import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfigTree } from "@callog/config-schema";
import { describe, expect, it } from "vitest";
import { runAction } from "./action";
import { PREVIEW_MARKER, previewMarkdown, slackBlocksToMarkdown } from "./preview";

const ROUTE = `
id: deploys
description: Deploys
allowed_sources: { api_keys: [cd] }
destinations: [{ slack: "#deploys" }, { telegram: "-100" }]
dm: true
template:
  - header: "Deployed {{ data.service }}"
  - text: "**{{ data.version }}** by {{ recipients | mention }} <script>"
  - buttons: [{ text: Diff, url: "https://git.example/{{ data.version }}" }]
examples:
  - data: { service: api, version: v2 }
    recipients: [github:bob]
`;

const config = () => {
  const parsed = parseConfigTree({
    "routes/deploys.yaml": ROUTE,
    "routes/other.yaml": ROUTE.replace("id: deploys", "id: other"),
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

describe("previewMarkdown", () => {
  it("shows routing, a Slack approximation with a builder link and Telegram", () => {
    const md = previewMarkdown(config(), ["deploys"]);
    expect(md.startsWith(PREVIEW_MARKER)).toBe(true);
    expect(md).toContain("**To:** Slack #deploys, Telegram -100 · personal copies to recipients");
    expect(md).toContain("**From:** key `cd`");
    expect(md).toContain("https://app.slack.com/block-kit-builder#");
    expect(md).toContain("> **Deployed api**");
    // Data and literal text stay text: no HTML injection into the comment.
    expect(md).toContain("> **v2** by bob &lt;script&gt;");
    expect(md).not.toContain("<script>");
    expect(md).toContain("[`Diff`](https://git.example/v2)");
    expect(md).toContain("<summary>Telegram</summary>");
    expect(md).not.toContain("### `other`");
  });

  it("does not ping GitHub users named in example data", () => {
    const tree = { "routes/deploys.yaml": ROUTE.replace("service: api", 'service: "@octocat"') };
    const parsed = parseConfigTree(tree);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const md = previewMarkdown(parsed.config, ["deploys"]);
    expect(md).not.toMatch(/@octocat/);
    expect(md).toContain("@\u200Boctocat");
  });

  it("says so when no route changed", () => {
    expect(previewMarkdown(config(), [])).toContain("No routes changed");
  });

  it("converts Slack mrkdwn", () => {
    expect(
      slackBlocksToMarkdown([
        {
          type: "section",
          text: { type: "mrkdwn", text: "*bold* ~s~ <https://x.dev|link> <@U1> a &lt; b" },
        },
        { type: "divider" },
      ]),
    ).toBe("**bold** ~~s~~ [link](https://x.dev) @U1 a &lt; b\n\n———");
  });
});

describe("runAction preview comments", () => {
  function setup(
    files: Record<string, string>,
    prFiles: string[],
    comments: { id: number; body: string }[] = [],
  ) {
    const root = mkdtempSync(path.join(tmpdir(), "notify-pr-"));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), c);
    }
    const eventPath = path.join(root, ".event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    const calls: { method: string; url: string; body?: { body: string } }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const u = url.replace("https://api.github.com", "");
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (u.startsWith("/repos/acme/notify-config/pulls/7/files")) {
        return Response.json(prFiles.map((filename) => ({ filename, status: "modified" })));
      }
      if (method === "GET" && u.startsWith("/repos/acme/notify-config/issues/7/comments")) {
        const page = Number(new URL(u, "https://x").searchParams.get("page") ?? 1);
        return Response.json(comments.slice((page - 1) * 100, page * 100));
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const run = () =>
      runAction({
        env: {
          GITHUB_WORKSPACE: root,
          INPUT_PATH: "notify",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "acme/notify-config",
          INPUT_TOKEN: "t",
        },
        fetch: fakeFetch,
        log: (l) => logs.push(l),
      });
    const env = {
      GITHUB_WORKSPACE: root,
      INPUT_PATH: "notify",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "acme/notify-config",
      INPUT_TOKEN: "t",
    };
    return { run, calls, logs, env };
  }

  it("posts one comment for the changed routes", async () => {
    const t = setup({ "notify/routes/deploys.yaml": ROUTE }, [
      "notify/routes/deploys.yaml",
      "README.md",
    ]);
    expect(await t.run()).toBe(0);
    const post = t.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/repos/acme/notify-config/issues/7/comments");
    expect(post.body!.body).toContain("### `deploys`");
  });

  it("updates its previous comment instead of adding another", async () => {
    const t = setup(
      { "notify/routes/deploys.yaml": ROUTE },
      ["notify/routes/deploys.yaml"],
      [
        { id: 1, body: "unrelated" },
        { id: 42, body: `${PREVIEW_MARKER}\nold` },
      ],
    );
    await t.run();
    expect(t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /repos/acme/notify-config/issues/comments/42",
    ]);
  });

  it("finds its comment on a later page and ignores comments quoting the marker", async () => {
    const chatter = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, body: "lgtm" }));
    chatter[20] = { id: 20, body: `> ${PREVIEW_MARKER}\n> quoted by a reviewer` };
    chatter[120] = { id: 120, body: `${PREVIEW_MARKER}\nold` };
    const t = setup(
      { "notify/routes/deploys.yaml": ROUTE },
      ["notify/routes/deploys.yaml"],
      chatter,
    );
    await t.run();
    expect(t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /repos/acme/notify-config/issues/comments/120",
    ]);
  });

  it("stays quiet when no route changed and there is no comment yet", async () => {
    const t = setup({ "notify/routes/deploys.yaml": ROUTE }, ["README.md"]);
    await t.run();
    expect(t.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("does not call GitHub for an invalid config", async () => {
    const t = setup({ "notify/routes/deploys.yaml": "id: nope" }, ["notify/routes/deploys.yaml"]);
    expect(await t.run()).toBe(1);
    expect(t.calls).toEqual([]);
  });

  it("warns instead of failing when the comment cannot be written", async () => {
    const t = setup({ "notify/routes/deploys.yaml": ROUTE }, ["notify/routes/deploys.yaml"]);
    const denied = (async (url: string, init: RequestInit) =>
      (init.method ?? "GET") === "POST"
        ? new Response("{}", { status: 403 })
        : Response.json(
            String(url).includes("/files")
              ? [{ filename: "notify/routes/deploys.yaml", status: "modified" }]
              : [],
          )) as unknown as typeof fetch;
    const logs: string[] = [];
    const code = await runAction({ env: t.env, fetch: denied, log: (l) => logs.push(l) });
    expect(code).toBe(0);
    expect(
      logs.some((l) => l.startsWith("::warning title=notify preview::") && l.includes("403")),
    ).toBe(true);
  });
});
