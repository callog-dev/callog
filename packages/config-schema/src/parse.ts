import { parseDocument } from "yaml";
import { compileDataSchema, dataIssues } from "./data-schema";
import type { z } from "zod";
import {
  configFileSchema,
  REMOVED_FILES,
  REMOVED_KEYS,
  routeSchema,
  teamsFileSchema,
  type ConfigFile,
  type Route,
  type Team,
} from "./schemas";

export interface Config {
  config: ConfigFile;
  teams: Record<string, Team>;
  routes: Record<string, Route>;
}

/**
 * `record[key]` without inherited members. Route ids and team slugs come from producers and
 * config files, and `constructor` is a valid slug.
 */
export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export interface ConfigIssue {
  /** Path of the file inside the config repo, e.g. `routes/fe-e2e-failed.yaml`. */
  file: string;
  /** Path inside the file, e.g. `["destinations", 0, "team"]`. Empty for whole-file issues. */
  path: (string | number)[];
  message: string;
}

export type ParseResult =
  | {
      ok: true;
      config: Config;
      warnings: ConfigIssue[];
      /** Route id → file it was defined in (`routes/<id>.yaml` or `.yml`). */
      routeFiles: Record<string, string>;
    }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/** Raw config repo contents: repo-relative path → file text. */
export type ConfigTree = Record<string, string>;

const ROOT_FILES = ["config.yaml", "teams.yaml"] as const;
const ROUTE_FILE = /^routes\/([^/]+)\.ya?ml$/;

/**
 * Parses and validates a whole config repo. Never throws on bad input:
 * every problem is reported as an issue with file and path.
 */
export function parseConfigTree(tree: ConfigTree): ParseResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  const config = parseFile(tree, "config.yaml", configFileSchema, errors);
  const teamsFile = parseFile(tree, "teams.yaml", teamsFileSchema, errors);
  for (const [file, message] of Object.entries(REMOVED_FILES)) {
    if (file in tree) errors.push({ file, path: [], message });
  }

  const routes: Record<string, Route> = {};
  const routeFiles: Record<string, string> = {};
  for (const file of Object.keys(tree).sort()) {
    const match = ROUTE_FILE.exec(file);
    if (!match) {
      const known = (ROOT_FILES as readonly string[]).includes(file) || file in REMOVED_FILES;
      if (isYaml(file) && !known) {
        warnings.push({ file, path: [], message: "unknown config file, ignored" });
      }
      continue;
    }
    const route = parseFile(tree, file, routeSchema, errors);
    if (!route) continue;
    if (route.id !== match[1]) {
      errors.push({ file, path: ["id"], message: `must match the file name "${match[1]}"` });
      continue;
    }
    const defined = ownValue(routeFiles, route.id);
    if (defined) {
      errors.push({
        file,
        path: ["id"],
        message: `duplicate route id, already defined in ${defined}`,
      });
      continue;
    }
    routes[route.id] = route;
    routeFiles[route.id] = file;
  }

  const teams = teamsFile?.teams ?? {};

  checkRoutes(routes, routeFiles, teams, errors);

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    config: { config: config ?? configFileSchema.parse({}), teams, routes },
    warnings,
    routeFiles,
  };
}

function isYaml(file: string): boolean {
  // Dot-directories (.github/workflows etc.) are not config.
  if (file.split("/").some((segment) => segment.startsWith("."))) return false;
  return file.endsWith(".yaml") || file.endsWith(".yml");
}

/** Missing files are treated as empty documents, so every file is optional. */
function parseFile<S extends z.ZodType>(
  tree: ConfigTree,
  file: string,
  schema: S,
  errors: ConfigIssue[],
): z.output<S> | undefined {
  const text = tree[file] ?? "";
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      errors.push({ file, path: [], message: `YAML: ${err.message}` });
    }
    return undefined;
  }
  const result = schema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.map((p) => (typeof p === "number" ? p : String(p)));
      if (issue.code !== "unrecognized_keys") {
        errors.push({ file, path, message: issue.message });
        continue;
      }
      // Keys that used to hold people get a pointer to where the data lives now.
      const unknown: string[] = [];
      for (const key of issue.keys) {
        const hint = REMOVED_KEYS[removedKeyId(file, path, key)];
        if (hint) errors.push({ file, path: [...path, key], message: hint });
        else unknown.push(key);
      }
      if (unknown.length > 0) {
        const quoted = unknown.map((k) => `"${k}"`).join(", ");
        errors.push({
          file,
          path,
          message: `Unrecognized key${unknown.length > 1 ? "s" : ""}: ${quoted}`,
        });
      }
    }
    return undefined;
  }
  return result.data;
}

/** `teams.yaml teams.*.members`: the path with record keys replaced by `*`. */
function removedKeyId(file: string, path: (string | number)[], key: string): string {
  const generic = path.map((p, i) => (i % 2 === 1 && path[i - 1] === "teams" ? "*" : p));
  return `${file} ${[...generic, key].join(".")}`;
}

function checkRoutes(
  routes: Record<string, Route>,
  routeFiles: Record<string, string>,
  teams: Record<string, Team>,
  errors: ConfigIssue[],
): void {
  for (const [id, route] of Object.entries(routes)) {
    const file = routeFiles[id]!;
    checkDataSchema(route, file, errors);
    let needsTelegram = false;
    route.destinations.forEach((destination, i) => {
      if ("telegram" in destination) needsTelegram = true;
      if (!("team" in destination)) return;
      const team = ownValue(teams, destination.team);
      if (!team) {
        errors.push({
          file,
          path: ["destinations", i, "team"],
          message: `unknown team "${destination.team}" (not defined in teams.yaml)`,
        });
        return;
      }
      if (!team.slack_channel && !team.telegram_chat) {
        errors.push({
          file,
          path: ["destinations", i, "team"],
          message: `team "${destination.team}" has neither slack_channel nor telegram_chat`,
        });
      }
      if (team.telegram_chat) needsTelegram = true;
    });
    // slack_blocks only render to Slack; Telegram needs the neutral template.
    if (needsTelegram && !route.template) {
      errors.push({
        file,
        path: ["template"],
        message: "a Telegram destination requires template (slack_blocks render only to Slack)",
      });
    }
  }
}

/** `schema` must be valid JSON Schema, and every example must satisfy it. */
function checkDataSchema(route: Route, file: string, errors: ConfigIssue[]): void {
  if (!route.schema) return;
  let validate;
  try {
    validate = compileDataSchema(route.schema);
  } catch (err) {
    errors.push({
      file,
      path: ["schema"],
      message: `not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  route.examples.forEach((example, i) => {
    for (const issue of dataIssues(validate, example.data)) {
      errors.push({
        file,
        path: ["examples", i, ...issue.path.split(".")],
        message: issue.message,
      });
    }
  });
}
