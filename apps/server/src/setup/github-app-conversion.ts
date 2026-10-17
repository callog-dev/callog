import type { CreatedGithubApp } from "./github-app-manifest";

/** The operator waits on the callback page: fail rather than hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Exchanges a manifest flow `code` for the created App's credentials; faked in tests. */
export interface GithubAppConversionClient {
  convert(code: string): Promise<CreatedGithubApp>;
}
export const GITHUB_APP_CONVERSION_CLIENT = Symbol("GITHUB_APP_CONVERSION_CLIENT");

export class GithubAppConversionError extends Error {}

export function createGithubAppConversionClient(): GithubAppConversionClient {
  return {
    async convert(code) {
      const res = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: { accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        // 404: the code is unknown, already used or older than an hour.
        throw new GithubAppConversionError(`GitHub answered ${res.status}`);
      }
      return (await res.json()) as CreatedGithubApp;
    },
  };
}
