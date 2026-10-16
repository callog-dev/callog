import type { Config, ConfigIssue } from "@callog/config-schema";
import { validateConfigTree } from "@callog/templates";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readConfigDir } from "./files";

export interface ValidateOptions {
  /** Config repo directory. */
  dir: string;
  /** Emit GitHub Actions annotations (`::error file=…::…`) as well. */
  annotations?: boolean;
  /** Repository root, so annotation paths point at the right files when `dir` is a subfolder. */
  repoRoot?: string;
}

export interface ValidateReport {
  ok: boolean;
  lines: string[];
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  summary: string;
  /** Present when valid. */
  config?: Config;
  /** Route id → file, relative to the config directory. */
  routeFiles: Record<string, string>;
}

/** `notify validate`: exactly the checks the server runs when loading the config. */
export function validate(options: ValidateOptions): ValidateReport {
  const result = validateConfigTree(readConfigDir(options.dir));
  const prefix = path
    .relative(options.repoRoot ?? options.dir, options.dir)
    .split(path.sep)
    .filter(Boolean)
    .join("/");
  const at = (issue: ConfigIssue) =>
    [issue.file, issue.path.join(".")].filter(Boolean).join(" › ") || "(repo)";
  const repoFile = (file: string) => (prefix ? `${prefix}/${file}` : file);

  const errors = result.ok ? [] : result.errors;
  const issueLines = [
    ...errors.map((e) => `✖ ${at(e)}: ${e.message}`),
    ...result.warnings.map((w) => `⚠ ${at(w)}: ${w.message}`),
  ];
  const lines: string[] = [];
  if (!options.annotations) {
    lines.push(...issueLines);
  } else {
    if (issueLines.length) {
      // Messages quote config lines (YAML errors show the source), and a PR controls those:
      // a line like `::add-mask::…` must not run as a workflow command in the Actions log.
      const token = randomBytes(16).toString("hex");
      lines.push(`::stop-commands::${token}`, ...issueLines, `::${token}::`);
    }
    for (const e of errors)
      lines.push(
        annotation("error", repoFile(e.file), `${e.path.join(".") || "file"}: ${e.message}`),
      );
    for (const w of result.warnings) lines.push(annotation("warning", repoFile(w.file), w.message));
  }

  const summary = result.ok
    ? `✔ Config is valid: ${count(Object.keys(result.config.routes).length, "route")}, ${count(Object.keys(result.config.teams).length, "team")}`
    : `✖ Config has ${count(errors.length, "error")} — the server would keep the previous version`;
  lines.push(summary);
  return {
    ok: result.ok,
    lines,
    errors,
    warnings: result.warnings,
    summary,
    config: result.ok ? result.config : undefined,
    routeFiles: result.ok ? result.routeFiles : {},
  };
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function annotation(kind: "error" | "warning", file: string, message: string): string {
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${kind} file=${esc(file).replace(/,/g, "%2C").replace(/:/g, "%3A")},title=notify config::${esc(message)}`;
}
