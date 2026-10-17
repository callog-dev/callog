import { readFileSync } from "node:fs";
import type { Env } from "../config/env";

export interface GithubAppConfig {
  appId: number;
  privateKey: string;
  webhookSecret: string;
}

export const GITHUB_APP_CONFIG = Symbol("GITHUB_APP_CONFIG");

/** `undefined` when the GitHub App is not configured. */
export function loadGithubAppConfig(env: Env): GithubAppConfig | undefined {
  // Checked before reading the key file: compose always sets GITHUB_APP_PRIVATE_KEY_PATH, and
  // before the App exists the mounted path is not a file.
  if (!env.GITHUB_APP_ID) return undefined;
  const privateKey =
    env.GITHUB_APP_PRIVATE_KEY ??
    (env.GITHUB_APP_PRIVATE_KEY_PATH
      ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8")
      : undefined);
  if (!privateKey || !env.GITHUB_WEBHOOK_SECRET) return undefined;
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  };
}
