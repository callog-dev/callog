import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./main";
import type { Runtime } from "./runtime";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function setup(inputs: Record<string, string>, responses: Array<Response | Error>, extraEnv = {}) {
  const outFile = path.join(mkdtempSync(path.join(tmpdir(), "action-")), "out");
  const env: NodeJS.ProcessEnv = {
    GITHUB_OUTPUT: outFile,
    GITHUB_REPOSITORY: "acme/e2e",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "test",
    GITHUB_ACTOR: "octocat",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const calls: Call[] = [];
  const logs: string[] = [];
  const queue = [...responses];
  const rt: Runtime = {
    env,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://oidc.example")) {
        return Response.json({ value: "oidc-jwt" });
      }
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    readFile: (p) => {
      if (p === "/event.json") {
        return JSON.stringify({ head_commit: { author: { username: "alice" } } });
      }
      throw new Error(`no file ${p}`);
    },
    log: (line) => logs.push(line),
    sleep: async () => {},
  };
  const notifyCalls = () => calls.filter((c) => c.url.endsWith("/v1/notify"));
  const output = () => {
    try {
      return readFileSync(outFile, "utf8");
    } catch {
      return "";
    }
  };
  return { rt, calls, notifyCalls, logs, output };
}

const accepted = () =>
  Response.json({ notification_id: "n-1", status: "accepted" }, { status: 202 });
const BASE = { url: "https://notify.example/", route: "e2e-failed" };

describe("action main", () => {
  it("sends with a GitHub OIDC token for the configured audience", async () => {
    const t = setup(
      { ...BASE, data: '{"branch":"main"}', recipients: "github:bob, team:fe\nemail:x@acme.com" },
      [accepted()],
    );

    expect(await main(t.rt)).toBe(0);

    expect(t.calls[0]!.url).toBe("https://oidc.example/token?x=1&audience=callog");
    const call = t.notifyCalls()[0]!;
    expect(call.url).toBe("https://notify.example/v1/notify");
    const headers = call.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oidc-jwt");
    expect(headers["idempotency-key"]).toMatch(/^gha:[0-9a-f]{40}$/);
    expect(JSON.parse(call.init!.body as string)).toEqual({
      route: "e2e-failed",
      data: { branch: "main" },
      recipients: ["github:bob", "team:fe", "email:x@acme.com"],
    });
    expect(t.output()).toBe("notification-id=n-1\n");
  });

  it("uses an API key when given and does not request OIDC", async () => {
    const t = setup({ ...BASE, "api-key": "ntf_secret" }, [accepted()]);
    expect(await main(t.rt)).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect((t.notifyCalls()[0]!.init!.headers as Record<string, string>).authorization).toBe(
      "Bearer ntf_secret",
    );
  });

  it("mentions the commit author from the push event", async () => {
    const t = setup({ ...BASE, recipients: "team:fe", "mention-author": "true" }, [accepted()], {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: "/event.json",
    });
    await main(t.rt);
    expect(JSON.parse(t.notifyCalls()[0]!.init!.body as string).recipients).toEqual([
      "team:fe",
      "github:alice",
    ]);
  });

  it("passes thread-key and update", async () => {
    const t = setup({ ...BASE, "thread-key": "e2e/main", update: "true" }, [accepted()]);
    await main(t.rt);
    expect(JSON.parse(t.notifyCalls()[0]!.init!.body as string)).toMatchObject({
      thread_key: "e2e/main",
      update: true,
    });
  });

  it("derives the same idempotency key for a re-run step and a different one for other data", async () => {
    const key = async (data: string) => {
      const t = setup({ ...BASE, data }, [accepted()]);
      await main(t.rt);
      return (t.notifyCalls()[0]!.init!.headers as Record<string, string>)["idempotency-key"];
    };
    expect(await key('{"a":1}')).toBe(await key('{"a":1}'));
    expect(await key('{"a":1}')).not.toBe(await key('{"a":2}'));
  });

  it("retries server errors and network failures with the same key", async () => {
    const t = setup(BASE, [
      new Error("ECONNRESET"),
      new Response("oops", { status: 502 }),
      accepted(),
    ]);
    expect(await main(t.rt)).toBe(0);
    const keys = t
      .notifyCalls()
      .map((c) => (c.init!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("only warns on client errors by default, with the server's explanation", async () => {
    const t = setup(BASE, [
      Response.json(
        {
          message: "data does not match the route schema",
          issues: [{ path: "data.branch", message: "is required" }],
        },
        { status: 422 },
      ),
    ]);
    expect(await main(t.rt)).toBe(0);
    expect(t.logs).toEqual([
      "::warning::callog: Server responded 422: data does not match the route schema — data.branch: is required",
    ]);
    expect(t.notifyCalls()).toHaveLength(1);
  });

  it("fails the step when fail-on-error is set", async () => {
    const t = setup({ ...BASE, "fail-on-error": "true" }, [
      Response.json({ message: "nope" }, { status: 403 }),
    ]);
    expect(await main(t.rt)).toBe(1);
    expect(t.logs[0]).toMatch(/^::error::callog: Server responded 403: nope/);
  });

  it("explains how to enable OIDC when the runner provides no token", async () => {
    const t = setup(BASE, [], { ACTIONS_ID_TOKEN_REQUEST_URL: "" });
    expect(await main(t.rt)).toBe(0);
    expect(t.logs[0]).toContain("permissions: id-token: write");
  });

  it("rejects data that is not a JSON object", async () => {
    const t = setup({ ...BASE, data: "[1]" }, []);
    await main(t.rt);
    expect(t.logs[0]).toContain('"data" must be a JSON object');
  });
});
