import { appendFileSync } from "node:fs";

/**
 * The few GitHub Actions runner conventions the action needs, without @actions/core:
 * inputs come from `INPUT_<NAME>` env vars, outputs go to the `GITHUB_OUTPUT` file,
 * annotations are `::warning::` / `::error::` lines on stdout.
 */
export interface Runtime {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  readFile: (path: string) => string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function input(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export function booleanInput(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = input(env, name).toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Input "${name}" must be true or false, got "${value}"`);
}

export function setOutput(env: NodeJS.ProcessEnv, name: string, value: string): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Escapes a message for a workflow command (`::warning::…`). */
export function annotation(kind: "warning" | "error", message: string): string {
  return `::${kind}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}
