import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { PREVIEW_MARKER, previewMarkdown } from "./preview";
import { validate, type ValidateReport } from "./validate";

export interface ActionRuntime {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  log: (line: string) => void;
}

/**
 * Config repo CI (`packages/cli/action.yml`): validate like the server does and, on pull
 * requests, keep one comment with a preview of the changed routes. Returns the exit code.
 */
export async function runAction(rt: ActionRuntime): Promise<number> {
  const { env } = rt;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const dir = path.resolve(workspace, (env.INPUT_PATH ?? "").trim() || ".");
  const report = validate({ dir, annotations: true, repoRoot: workspace });
  for (const line of report.lines) rt.log(line);
  writeSummary(env, report);

  if (
    report.ok &&
    env.GITHUB_EVENT_NAME?.startsWith("pull_request") &&
    (env.INPUT_PREVIEW ?? "true") !== "false"
  ) {
    try {
      await commentPreview(rt, report, path.relative(workspace, dir));
    } catch (err) {
      // A missing preview must not fail the check.
      rt.log(`::warning title=notify preview::${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report.ok ? 0 : 1;
}

async function commentPreview(
  rt: ActionRuntime,
  report: ValidateReport,
  configDir: string,
): Promise<void> {
  const { env } = rt;
  const token = env.INPUT_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8")) as {
    pull_request?: { number: number };
  };
  const number = event.pull_request?.number;
  if (!token || !repo || !number) throw new Error("preview needs a pull_request event and a token");

  const api = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await rt.fetch(`${env.GITHUB_API_URL ?? "https://api.github.com"}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok)
      throw new Error(
        `GitHub API ${method} ${url}: ${res.status} (does the job have pull-requests: write?)`,
      );
    return (await res.json()) as T;
  };

  const changed = new Set<string>();
  for (let page = 1; page <= 30; page++) {
    const files = await api<{ filename: string; status: string }[]>(
      "GET",
      `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    for (const f of files) if (f.status !== "removed") changed.add(f.filename);
    if (files.length < 100) break;
  }
  const prefix = configDir ? `${configDir.split(path.sep).join("/")}/` : "";
  const routeIds = Object.entries(report.routeFiles)
    .filter(([, file]) => changed.has(prefix + file))
    .map(([id]) => id)
    .sort();

  // Our comment starts with the marker; a reviewer quoting it does not. Long PRs have
  // more than one page of comments.
  let existing: { id: number } | undefined;
  for (let page = 1; page <= 30 && !existing; page++) {
    const comments = await api<{ id: number; body?: string }[]>(
      "GET",
      `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    existing = comments.find((c) => c.body?.startsWith(PREVIEW_MARKER));
    if (comments.length < 100) break;
  }
  if (routeIds.length === 0 && !existing) return; // nothing to say, don't add noise
  const body = previewMarkdown(report.config!, routeIds, report.routeFiles);
  if (existing) await api("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  else await api("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  rt.log(`Preview ${existing ? "updated" : "posted"} for ${routeIds.length} route(s)`);
}

function writeSummary(env: NodeJS.ProcessEnv, report: ValidateReport): void {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const rows = [
    ...report.errors.map((issue) => ({ icon: "❌", issue })),
    ...report.warnings.map((issue) => ({ icon: "⚠️", issue })),
  ];
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      `### notify config\n\n${report.summary}\n`,
      ...(rows.length
        ? [
            "| | Where | Problem |",
            "|---|---|---|",
            ...rows.map(
              ({ icon, issue: i }) =>
                `| ${icon} | \`${[i.file, i.path.join(".")].filter(Boolean).join(" › ")}\` | ${i.message.replace(/\|/g, "\\|")} |`,
            ),
          ]
        : []),
      "",
    ].join("\n"),
  );
}
