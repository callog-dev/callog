import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { safeEqual } from "../crypto/digest";
import { AccountLinkingService } from "../identity/account-linking.service";
import {
  GITHUB_OAUTH_CLIENT,
  GithubOAuthConfig,
  type GithubOAuthClient,
} from "../identity/github-oauth";
import { clearCookie, cookie, readCookie } from "./cookies";
import {
  LOGIN_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_S,
  SessionsService,
} from "./sessions.service";

/** `state` of a web login; anything else in `state` is a one-time link token. */
const LOGIN_STATE_PREFIX = "login.";
/** Nonce of the browser that did a link's OAuth; only it can confirm the link. */
const LINK_CONFIRM_COOKIE = "callog_link_confirm";
const LINK_CONFIRM_TTL_S = 15 * 60;
/** The pages are static: no scripts, no framing (a confirm button must not be clickjacked). */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/**
 * The GitHub App's OAuth callback serves two flows (one callback URL to configure):
 * web UI login and `/notify link github`.
 */
@Controller()
export class GithubOAuthController {
  private readonly logger = new Logger(GithubOAuthController.name);

  constructor(
    private readonly config: GithubOAuthConfig,
    @Inject(GITHUB_OAUTH_CLIENT) private readonly oauth: GithubOAuthClient,
    private readonly linking: AccountLinkingService,
    private readonly sessions: SessionsService,
  ) {}

  @Get("auth/github/login")
  login(@Res({ passthrough: true }) reply: FastifyReply): void {
    if (!this.config.enabled) {
      reply
        .status(503)
        .header("content-type", "text/html; charset=utf-8")
        .send(page("GitHub login is not configured on this server."));
      return;
    }
    const state = `${LOGIN_STATE_PREFIX}${randomBytes(24).toString("base64url")}`;
    reply
      .header(
        "set-cookie",
        cookie(LOGIN_STATE_COOKIE, state, {
          maxAgeSeconds: 600,
          secure: this.sessions.secureCookies,
        }),
      )
      .redirect(this.config.authorizeUrl(state), 302);
  }

  @Get("oauth/github/callback")
  @Header("cache-control", "no-store")
  @Header("content-security-policy", PAGE_CSP)
  async callback(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query("code") code?: string,
    @Query("state") state?: string,
  ): Promise<string | void> {
    reply.header("content-type", "text/html; charset=utf-8");
    if (!this.config.enabled) return page("GitHub sign-in is not configured on this server.");
    if (!code || !state)
      return page("The link is incomplete. Run /notify link github in Slack again.");

    const isLogin = state.startsWith(LOGIN_STATE_PREFIX);
    // A login must come back to the browser that started it (CSRF protection).
    if (isLogin && !safeEqual(state, readCookie(req.headers.cookie, LOGIN_STATE_COOKIE))) {
      return page("This sign-in attempt expired. Please sign in again.");
    }

    let user;
    try {
      user = await this.oauth.userFromCode(code);
    } catch (err) {
      this.logger.warn(`GitHub OAuth failed: ${String(err)}`);
      return page(
        isLogin
          ? "GitHub did not confirm the sign-in. Please try again."
          : "GitHub did not confirm the account. Run /notify link github in Slack again.",
      );
    }

    if (isLogin) {
      const who = await this.sessions.personForGithubUser(user.id);
      if (!who) {
        return page(
          `GitHub @${user.login} is not linked to anyone here yet. Run /notify link github in Slack, then sign in again.`,
        );
      }
      const token = await this.sessions.create(who);
      reply
        .header("set-cookie", [
          cookie(SESSION_COOKIE, token, {
            maxAgeSeconds: SESSION_TTL_S,
            secure: this.sessions.secureCookies,
          }),
          clearCookie(LOGIN_STATE_COOKIE, this.sessions.secureCookies),
        ])
        .redirect("/", 302);
      return;
    }

    // A link URL can be forwarded: the account is linked only after its owner confirms
    // whom it goes to, in this browser.
    const staged = await this.linking.stage("github", state, {
      externalId: String(user.id),
      handle: user.login,
    });
    if (!staged.ok) return page(INVALID_LINK);
    reply.header(
      "set-cookie",
      cookie(LINK_CONFIRM_COOKIE, staged.nonce, {
        maxAgeSeconds: LINK_CONFIRM_TTL_S,
        secure: this.sessions.secureCookies,
      }),
    );
    return page(
      `Link GitHub @${user.login} to ${staged.personName}? Their notifications will mention ` +
        "this GitHub account. If you did not ask for this link yourself, just close the tab.",
      {
        icon: "🔗",
        confirm: {
          action: `/oauth/github/confirm?state=${encodeURIComponent(state)}`,
          label: `Link to ${staged.personName}`,
        },
      },
    );
  }

  @Post("oauth/github/confirm")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  @Header("content-security-policy", PAGE_CSP)
  async confirm(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query("state") state?: string,
  ): Promise<string> {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("set-cookie", clearCookie(LINK_CONFIRM_COOKIE, this.sessions.secureCookies));
    if (!state) return page(INVALID_LINK);
    const nonce = readCookie(req.headers.cookie, LINK_CONFIRM_COOKIE);
    const outcome = await this.linking.confirm("github", state, nonce);
    if (outcome.ok) {
      return page(`Linked GitHub to ${outcome.personName}. You can close this tab.`, {
        icon: "✅",
      });
    }
    return page(
      outcome.reason === "invalid_token"
        ? INVALID_LINK
        : "This GitHub account is already linked to someone else. Ask an admin to fix it.",
    );
  }
}

const INVALID_LINK = "This link is invalid or expired. Run /notify link github in Slack again.";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(
  message: string,
  { icon = "⚠️", confirm }: { icon?: string; confirm?: { action: string; label: string } } = {},
): string {
  const form = confirm
    ? `<form method="post" action="${escapeHtml(confirm.action)}"><button>${escapeHtml(confirm.label)}</button></form>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Callog</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}a{color:inherit}</style></head>
<body><h1>${icon} Callog</h1><p>${escapeHtml(message)}</p>${form}<p><a href="/">Open Callog</a></p></body></html>`;
}
