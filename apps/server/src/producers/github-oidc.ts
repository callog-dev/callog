import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_KEY_RESOLVER = Symbol("OIDC_KEY_RESOLVER");

/** GitHub's signing keys, fetched and cached by jose. Replaced by a local key in tests. */
export function githubActionsKeys(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));
}

export interface GithubActionsClaims {
  repository: string;
  repositoryOwner: string;
  /** The org's numeric id: stable across renames, unlike the login. */
  repositoryOwnerId?: number;
}

/**
 * Verifies a GitHub Actions OIDC token: signature by GitHub's
 * JWKS, issuer, audience and expiry. Throws on any failure.
 */
export async function verifyGithubActionsToken(
  token: string,
  keys: JWTVerifyGetKey,
  audience: string,
): Promise<GithubActionsClaims> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience,
    algorithms: ["RS256"],
  });
  const repository = payload.repository;
  const owner = payload.repository_owner;
  if (typeof repository !== "string" || typeof owner !== "string") {
    throw new Error("token has no repository claims");
  }
  const ownerId = Number(payload.repository_owner_id);
  return {
    repository,
    repositoryOwner: owner,
    repositoryOwnerId: Number.isSafeInteger(ownerId) && ownerId > 0 ? ownerId : undefined,
  };
}
