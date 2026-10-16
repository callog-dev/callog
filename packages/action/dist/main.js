"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionError = void 0;
exports.main = main;
const node_crypto_1 = require("node:crypto");
const event_1 = require("./event");
const runtime_1 = require("./runtime");
const RETRIES = 3;
class ActionError extends Error {
}
exports.ActionError = ActionError;
/** Runs the action; returns the process exit code. Never throws. */
async function main(rt) {
    let failOnError = false;
    try {
        failOnError = (0, runtime_1.booleanInput)(rt.env, "fail-on-error");
        const id = await send(rt);
        (0, runtime_1.setOutput)(rt.env, "notification-id", id);
        rt.log(`Notification ${id} accepted`);
        return 0;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A notification must not break the pipeline unless asked to.
        rt.log((0, runtime_1.annotation)(failOnError ? "error" : "warning", `callog: ${message}`));
        return failOnError ? 1 : 0;
    }
}
async function send(rt) {
    const { env } = rt;
    const url = (0, runtime_1.input)(env, "url").replace(/\/+$/, "");
    const route = (0, runtime_1.input)(env, "route");
    if (!url)
        throw new ActionError('Input "url" is required');
    if (!route)
        throw new ActionError('Input "route" is required');
    const body = buildBody(rt, route);
    const token = (0, runtime_1.input)(env, "api-key") || (await oidcToken(rt, (0, runtime_1.input)(env, "audience") || "callog"));
    const idempotencyKey = (0, runtime_1.input)(env, "idempotency-key") || defaultIdempotencyKey(env, body);
    for (let attempt = 1;; attempt++) {
        let res;
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
        }
        catch (err) {
            if (attempt < RETRIES) {
                await rt.sleep(1000 * 2 ** attempt);
                continue;
            }
            throw new ActionError(`Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (res.status === 202)
            return (await res.json()).notification_id;
        // Safe to retry: the idempotency key prevents duplicates.
        if (res.status >= 500 && attempt < RETRIES) {
            await rt.sleep(1000 * 2 ** attempt);
            continue;
        }
        throw new ActionError(`Server responded ${res.status}: ${await describe(res)}`);
    }
}
function buildBody(rt, route) {
    const { env } = rt;
    let data;
    try {
        data = JSON.parse((0, runtime_1.input)(env, "data") || "{}");
    }
    catch (err) {
        throw new ActionError(`Input "data" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ActionError('Input "data" must be a JSON object');
    }
    const recipients = (0, runtime_1.input)(env, "recipients")
        .split(/[\n,]/)
        .map((r) => r.trim())
        .filter(Boolean);
    if ((0, runtime_1.booleanInput)(env, "mention-author")) {
        let event;
        try {
            event = env.GITHUB_EVENT_PATH ? JSON.parse(rt.readFile(env.GITHUB_EVENT_PATH)) : undefined;
        }
        catch {
            event = undefined;
        }
        const author = (0, event_1.eventAuthor)(env.GITHUB_EVENT_NAME, event, env.GITHUB_ACTOR);
        if (author && !recipients.includes(`github:${author}`))
            recipients.push(`github:${author}`);
    }
    const threadKey = (0, runtime_1.input)(env, "thread-key");
    return {
        route,
        data: data,
        recipients,
        ...(threadKey ? { thread_key: threadKey } : {}),
        ...((0, runtime_1.booleanInput)(env, "update") ? { update: true } : {}),
    };
}
/** Same run, attempt, job and request ⇒ same key: a retried step is not delivered twice. */
function defaultIdempotencyKey(env, body) {
    const scope = [
        env.GITHUB_REPOSITORY,
        env.GITHUB_RUN_ID,
        env.GITHUB_RUN_ATTEMPT,
        env.GITHUB_JOB,
    ].join(":");
    return `gha:${(0, node_crypto_1.createHash)("sha256")
        .update(`${scope}\n${JSON.stringify(body)}`)
        .digest("hex")
        .slice(0, 40)}`;
}
async function oidcToken(rt, audience) {
    const requestUrl = rt.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = rt.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) {
        throw new ActionError("GitHub OIDC is not available: add `permissions: id-token: write` to the job, or pass api-key");
    }
    const res = await rt.fetch(`${requestUrl}&audience=${encodeURIComponent(audience)}`, {
        headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
    });
    if (!res.ok)
        throw new ActionError(`Cannot get a GitHub OIDC token: HTTP ${res.status}`);
    const { value } = (await res.json());
    if (!value)
        throw new ActionError("GitHub returned an empty OIDC token");
    return value;
}
async function describe(res) {
    const text = await res.text();
    try {
        const json = JSON.parse(text);
        const issues = json.issues?.map((i) => `${i.path || "(body)"}: ${i.message}`).join("; ");
        return [json.message, issues].filter(Boolean).join(" — ") || text;
    }
    catch {
        return text;
    }
}
//# sourceMappingURL=main.js.map