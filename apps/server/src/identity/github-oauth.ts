import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env";

const GITHUB_OAUTH_CALLBACK_PATH = "/oauth/github/callback";
/** The user waits on the callback page: fail rather than hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Exchanges an OAuth code for the GitHub user who approved it; faked in tests. */
export interface GithubOAuthClient {
  userFromCode(code: string): Promise<{ id: number; login: string }>;
}
export const GITHUB_OAUTH_CLIENT = Symbol("GITHUB_OAUTH_CLIENT");

export class GithubOAuthError extends Error {}

export function createGithubOAuthClient(env: Env): GithubOAuthClient {
  return {
    async userFromCode(code) {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_APP_CLIENT_ID,
          client_secret: env.GITHUB_APP_CLIENT_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const token = (await tokenRes.json()) as {
        access_token?: string;
        error_description?: string;
      };
      if (!token.access_token)
        throw new GithubOAuthError(token.error_description ?? "code exchange failed");
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!userRes.ok) throw new GithubOAuthError(`GET /user failed: ${userRes.status}`);
      const user = (await userRes.json()) as { id: number; login: string };
      return { id: user.id, login: user.login };
    },
  };
}

@Injectable()
export class GithubOAuthConfig {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(
      this.env.GITHUB_APP_CLIENT_ID && this.env.GITHUB_APP_CLIENT_SECRET && this.env.PUBLIC_URL,
    );
  }

  /** GitHub's consent page; `state` is a one-time link token or a web login state. */
  authorizeUrl(state: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.env.GITHUB_APP_CLIENT_ID!);
    url.searchParams.set(
      "redirect_uri",
      `${this.env.PUBLIC_URL!.replace(/\/+$/, "")}${GITHUB_OAUTH_CALLBACK_PATH}`,
    );
    url.searchParams.set("state", state);
    return url.toString();
  }
}
