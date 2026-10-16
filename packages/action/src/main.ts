import { createHash } from "node:crypto";
import { eventAuthor } from "./event";
import { annotation, booleanInput, input, setOutput, type Runtime } from "./runtime";

const RETRIES = 3;

interface NotifyBody {
  route: string;
  data: Record<string, unknown>;
  recipients: string[];
  thread_key?: string;
  update?: boolean;
}

export class ActionError extends Error {}

/** Runs the action; returns the process exit code. Never throws. */
export async function main(rt: Runtime): Promise<number> {
  let failOnError = false;
  try {
    failOnError = booleanInput(rt.env, "fail-on-error");
    const id = await send(rt);
    setOutput(rt.env, "notification-id", id);
    rt.log(`Notification ${id} accepted`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A notification must not break the pipeline unless asked to.
    rt.log(annotation(failOnError ? "error" : "warning", `callog: ${message}`));
    return failOnError ? 1 : 0;
  }
}

async function send(rt: Runtime): Promise<string> {
  const { env } = rt;
  const url = input(env, "url").replace(/\/+$/, "");
  const route = input(env, "route");
  if (!url) throw new ActionError('Input "url" is required');
  if (!route) throw new ActionError('Input "route" is required');

  const body = buildBody(rt, route);
  const token = input(env, "api-key") || (await oidcToken(rt, input(env, "audience") || "callog"));
  const idempotencyKey = input(env, "idempotency-key") || defaultIdempotencyKey(env, body);

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await rt.fetch(`${url}/v1/notify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "user-agent": "callog-action",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < RETRIES) {
        await rt.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ActionError(
        `Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 202)
      return ((await res.json()) as { notification_id: string }).notification_id;
    // Safe to retry: the idempotency key prevents duplicates.
    if (res.status >= 500 && attempt < RETRIES) {
      await rt.sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new ActionError(`Server responded ${res.status}: ${await describe(res)}`);
  }
}

function buildBody(rt: Runtime, route: string): NotifyBody {
  const { env } = rt;
  let data: unknown;
  try {
    data = JSON.parse(input(env, "data") || "{}");
  } catch (err) {
    throw new ActionError(
      `Input "data" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ActionError('Input "data" must be a JSON object');
  }

  const recipients = input(env, "recipients")
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (booleanInput(env, "mention-author")) {
    let event: unknown;
    try {
      event = env.GITHUB_EVENT_PATH ? JSON.parse(rt.readFile(env.GITHUB_EVENT_PATH)) : undefined;
    } catch {
      event = undefined;
    }
    const author = eventAuthor(env.GITHUB_EVENT_NAME, event, env.GITHUB_ACTOR);
    if (author && !recipients.includes(`github:${author}`)) recipients.push(`github:${author}`);
  }

  const threadKey = input(env, "thread-key");
  return {
    route,
    data: data as Record<string, unknown>,
    recipients,
    ...(threadKey ? { thread_key: threadKey } : {}),
    ...(booleanInput(env, "update") ? { update: true } : {}),
  };
}

/** Same run, attempt, job and request ⇒ same key: a retried step is not delivered twice. */
function defaultIdempotencyKey(env: NodeJS.ProcessEnv, body: NotifyBody): string {
  const scope = [
    env.GITHUB_REPOSITORY,
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB,
  ].join(":");
  return `gha:${createHash("sha256")
    .update(`${scope}\n${JSON.stringify(body)}`)
    .digest("hex")
    .slice(0, 40)}`;
}

async function oidcToken(rt: Runtime, audience: string): Promise<string> {
  const requestUrl = rt.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = rt.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new ActionError(
      "GitHub OIDC is not available: add `permissions: id-token: write` to the job, or pass api-key",
    );
  }
  const res = await rt.fetch(`${requestUrl}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new ActionError(`Cannot get a GitHub OIDC token: HTTP ${res.status}`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new ActionError("GitHub returned an empty OIDC token");
  return value;
}

async function describe(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as {
      message?: unknown;
      issues?: { path: string; message: string }[];
    };
    const issues = json.issues?.map((i) => `${i.path || "(body)"}: ${i.message}`).join("; ");
    return [json.message, issues].filter(Boolean).join(" — ") || text;
  } catch {
    return text;
  }
}
