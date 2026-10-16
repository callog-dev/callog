"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventAuthor = eventAuthor;
/**
 * The GitHub user to mention as "the author" of a run: commit or PR author when the
 * event has one, otherwise the actor who triggered the run.
 */
function eventAuthor(eventName, event, actor) {
    const e = (event ?? {}); // eslint-disable-line @typescript-eslint/no-explicit-any
    const candidates = [];
    switch (eventName) {
        case "push":
            candidates.push(e.head_commit?.author?.username, e.pusher?.name);
            break;
        case "pull_request":
        case "pull_request_target":
        case "pull_request_review":
            candidates.push(e.pull_request?.user?.login);
            break;
        case "workflow_run":
            candidates.push(e.workflow_run?.head_commit?.author?.username, e.workflow_run?.actor?.login);
            break;
    }
    candidates.push(actor);
    const login = candidates.find((c) => typeof c === "string" && c.length > 0);
    // Bots cannot be mentioned meaningfully.
    return login && !login.endsWith("[bot]") ? login : undefined;
}
//# sourceMappingURL=event.js.map