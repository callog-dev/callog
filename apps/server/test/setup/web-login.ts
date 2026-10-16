import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/** `name=value` pairs of Set-Cookie headers, ready for a Cookie header. */
export const cookiesOf = (setCookie: string | string[] | undefined) =>
  ([] as string[]).concat(setCookie ?? []).map((c) => c.split(";")[0]!);

/** Signs a GitHub user into the web UI through the real OAuth flow; returns the cookie header. */
export async function webLogin(
  app: NestFastifyApplication,
  githubOAuthUsers: Map<string, { id: number; login: string }>,
  user: { id: number; login: string },
): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/auth/github/login" });
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const code = `code-${user.id}-${Math.random()}`;
  githubOAuthUsers.set(code, user);
  const callback = await app.inject({
    method: "GET",
    url: `/oauth/github/callback?code=${code}&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookiesOf(start.headers["set-cookie"]).join("; ") },
  });
  const session = cookiesOf(callback.headers["set-cookie"]).find((c) =>
    c.startsWith("callog_session="),
  );
  if (!session) throw new Error(`login failed: ${callback.body}`);
  return session;
}
