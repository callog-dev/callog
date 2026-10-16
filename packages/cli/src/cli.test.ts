import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { send } from "./send";
import { validate } from "./validate";

const FIXTURE = path.resolve(__dirname, "../../config-schema/fixtures/valid");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "notify-config-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const BROKEN_ROUTE = `
id: broken
allowed_sources: { api_keys: [ci] }
destinations: [{ team: ghosts }]
template: [{ buttons: [{ text: Go, url: "{{ data.u }}" }] }]
examples: [{ data: { u: "not a url" } }]
`;

describe("notify validate", () => {
  it("accepts the reference config", () => {
    const report = validate({ dir: FIXTURE });
    expect(report.ok).toBe(true);
    expect(report.summary).toBe("✔ Config is valid: 1 route, 1 team");
  });

  it("reports config and template errors with file and path", () => {
    const report = validate({ dir: repo({ "routes/broken.yaml": BROKEN_ROUTE }) });
    expect(report.ok).toBe(false);
    expect(report.lines).toEqual([
      '✖ routes/broken.yaml › destinations.0.team: unknown team "ghosts" (not defined in teams.yaml)',
      "✖ Config has 1 error — the server would keep the previous version",
    ]);
  });

  it("checks templates once the config itself is valid", () => {
    const fixed = BROKEN_ROUTE.replace("{ team: ghosts }", '{ slack: "#x" }');
    const report = validate({ dir: repo({ "routes/broken.yaml": fixed }) });
    expect(report.errors).toEqual([
      {
        file: "routes/broken.yaml",
        path: ["template", 0, "buttons", 0, "url"],
        message: 'example 0: rendered URL must be http(s), got "not a url"',
      },
    ]);
  });

  it("reads symlinks as git stores them (the target path), never following them", () => {
    const outside = repo({ "secret.yaml": "id: leaked-secret" });
    const dir = repo({});
    mkdirSync(path.join(dir, "routes"));
    symlinkSync(path.join(outside, "secret.yaml"), path.join(dir, "routes/a.yaml"));
    symlinkSync(outside, path.join(dir, "routes/dir.yaml"));

    const report = validate({ dir });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).not.toContain("leaked-secret");
  });

  it("ignores dot-directories and emits GitHub annotations relative to the repo root", () => {
    const root = repo({
      ".github/workflows/ci.yml": "on: push",
      "notify/routes/broken.yaml": BROKEN_ROUTE,
    });
    const report = validate({ dir: path.join(root, "notify"), repoRoot: root, annotations: true });
    expect(report.lines).toContain(
      '::error file=notify/routes/broken.yaml,title=notify config::destinations.0.team: unknown team "ghosts" (not defined in teams.yaml)',
    );
  });

  it("keeps workflow commands in the config from running in the Actions log", () => {
    const dir = repo({ "routes/a.yaml": "id: a\nfoo: [\n::add-mask::injected\n" });
    const log = validate({ dir, annotations: true }).lines.join("\n").split("\n");
    const injected = log.findIndex((l) => l.startsWith("::add-mask::injected"));
    const stop = log.findIndex((l) => l.startsWith("::stop-commands::"));
    const token = log[stop]?.slice("::stop-commands::".length);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(injected);
    expect(log.indexOf(`::${token}::`)).toBeGreaterThan(injected);
  });
});

describe("notify send", () => {
  const fakeFetch = (status: number, body: object) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  let calls: { url: string; init: RequestInit }[] = [];

  it("posts to /v1/notify with the API key", async () => {
    calls = [];
    const id = await send(
      {
        url: "https://n.example/",
        apiKey: "ntf_x",
        route: "r",
        data: '{"a":1}',
        recipients: ["github:bob"],
        threadKey: "t",
        idempotencyKey: "k",
      },
      fakeFetch(202, { notification_id: "n1" }),
    );
    expect(id).toBe("n1");
    expect(calls[0]!.url).toBe("https://n.example/v1/notify");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer ntf_x",
      "idempotency-key": "k",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      route: "r",
      data: { a: 1 },
      recipients: ["github:bob"],
      thread_key: "t",
    });
  });

  it("rejects --data that is valid JSON but not an object", async () => {
    calls = [];
    for (const data of ["[1]", '"x"', "null"]) {
      const options = { url: "https://n.example", apiKey: "k", route: "r", data, recipients: [] };
      await expect(send(options, fakeFetch(202, {}))).rejects.toThrow(
        "--data must be a JSON object",
      );
    }
    expect(calls).toEqual([]);
  });

  it("explains server errors", async () => {
    await expect(
      send(
        { url: "https://n.example", apiKey: "k", route: "r", data: "{}", recipients: [] },
        fakeFetch(422, {
          message: "data does not match the route schema",
          issues: [{ path: "data.branch", message: "is required" }],
        }),
      ),
    ).rejects.toThrow("HTTP 422: data does not match the route schema — data.branch: is required");
  });
});

describe("built entry points", () => {
  const bin = path.resolve(__dirname, "../dist/bin.js");
  const action = path.resolve(__dirname, "../dist-action/index.js");

  it("bin exits 0 for a valid config and 1 for an invalid one", () => {
    expect(execFileSync("node", [bin, "validate", FIXTURE], { encoding: "utf8" })).toContain(
      "Config is valid",
    );
    const failed = spawnSync(
      "node",
      [bin, "validate", repo({ "routes/broken.yaml": BROKEN_ROUTE })],
      { encoding: "utf8" },
    );
    expect(failed.status).toBe(1);
  });

  it("the bundled action fails the check and writes a job summary", () => {
    const root = repo({ "routes/broken.yaml": BROKEN_ROUTE });
    const summary = path.join(root, "summary.md");
    const run = spawnSync("node", [action], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_WORKSPACE: root, GITHUB_STEP_SUMMARY: summary },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error file=routes/broken.yaml");
    expect(readFileSync(summary, "utf8")).toContain(
      "| ❌ | `routes/broken.yaml › destinations.0.team` |",
    );
  });
});
