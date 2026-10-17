import {
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Query,
  Req,
  Res,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { ENV, type Env } from "../config/env";
import { safeEqual } from "../crypto/digest";
import { GITHUB_APP_CONFIG, type GithubAppConfig } from "../github/github.config";
import { clearCookie, cookie, readCookie } from "../web/cookies";
import { escapeHtml, htmlDocument } from "../web/html";
import {
  GITHUB_APP_CONVERSION_CLIENT,
  type GithubAppConversionClient,
} from "./github-app-conversion";
import {
  buildManifest,
  defaultAppName,
  envBlock,
  isLocalUrl,
  SETUP_PATH,
} from "./github-app-manifest";

/** Ties GitHub's redirect back to the browser that started the flow. */
const STATE_COOKIE = "callog_setup_state";
/** GitHub accepts a manifest code for an hour. */
const STATE_TTL_S = 60 * 60;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** No scripts; the only foreign form target is GitHub's App registration page. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'";

/**
 * First start without a GitHub App: registers one in the operator's org with GitHub's
 * manifest flow and shows its credentials once, as `.env` lines. Nothing is stored: the
 * operator puts the lines into `.env` and restarts, so the App stays configured the same way
 * as one registered by hand. Whoever runs the flow only sees an App they created themselves.
 */
@Controller(SETUP_PATH.slice(1))
export class GithubAppSetupController implements OnApplicationBootstrap {
  private readonly logger = new Logger(GithubAppSetupController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(GITHUB_APP_CONFIG) private readonly app: GithubAppConfig | undefined,
    @Inject(GITHUB_APP_CONVERSION_CLIENT) private readonly conversion: GithubAppConversionClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.app) return;
    const where = this.env.PUBLIC_URL
      ? `open ${this.publicUrl}${SETUP_PATH} to create one`
      : "set PUBLIC_URL, restart and open it in a browser to create one";
    this.logger.warn(`GitHub App is not configured: ${where}`);
  }

  @Get()
  start(@Res({ passthrough: true }) reply: FastifyReply): string {
    this.ensureNotConfigured();
    this.pageHeaders(reply);
    if (!this.env.PUBLIC_URL) {
      return page(
        `<p>Set <code>PUBLIC_URL</code> in <code>.env</code> to the address people open Callog at, restart the server and reload this page.</p>`,
      );
    }
    const local = isLocalUrl(this.publicUrl);
    const relay = local
      ? `<label for="webhook">Webhook relay URL</label>
<input id="webhook" name="webhook" type="url" required placeholder="https://smee.io/…">
<small>GitHub cannot reach ${escapeHtml(this.publicUrl)}. Create a channel at <a href="https://smee.io/new">smee.io/new</a>, paste it here and forward it with <code>pnpm tunnel</code>.</small>`
      : "";
    return page(`<p>Create the GitHub App Callog uses to read your config repo and org members.
You need to be an owner of the organization.</p>
<form method="get" action="${SETUP_PATH}/new">
<label for="org">GitHub organization</label>
<input id="org" name="org" required pattern="[A-Za-z0-9-]+" autocomplete="off" placeholder="acme">
${relay}
<button>Continue</button></form>`);
  }

  @Get("new")
  confirm(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query("org") org?: string,
    @Query("webhook") webhook?: string,
  ): string {
    this.ensureNotConfigured();
    this.pageHeaders(reply);
    if (!this.env.PUBLIC_URL) return this.start(reply);
    if (!org || !GITHUB_LOGIN.test(org)) return retry("That is not a GitHub organization name.");
    const webhookUrl = isLocalUrl(this.publicUrl)
      ? webhook && /^https:\/\//.test(webhook) && !isLocalUrl(webhook)
        ? webhook
        : undefined
      : `${this.publicUrl}/webhooks/github`;
    if (!webhookUrl) return retry("The webhook relay URL must be a public https:// address.");

    const state = randomBytes(24).toString("base64url");
    reply.header("set-cookie", cookie(STATE_COOKIE, state, this.cookieOptions(STATE_TTL_S)));
    const manifest = buildManifest({
      publicUrl: this.publicUrl,
      webhookUrl,
      name: defaultAppName(org),
    });
    const action = `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
    return page(`<p>GitHub will ask you to confirm the App in <b>${escapeHtml(org)}</b>.
You can change its name there.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button>Create on GitHub</button></form>
<p><a href="${SETUP_PATH}">Back</a></p>`);
  }

  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query("code") code?: string,
    @Query("state") state?: string,
  ): Promise<string> {
    this.ensureNotConfigured();
    this.pageHeaders(reply);
    // The credentials below are shown once and must not linger in caches.
    reply
      .header("cache-control", "no-store")
      .header("set-cookie", clearCookie(STATE_COOKIE, this.secureCookies));
    const expected = readCookie(req.headers.cookie, STATE_COOKIE);
    if (!code || !state || !expected || !safeEqual(expected, state)) {
      return retry("This page was opened outside the setup flow or the flow has expired.");
    }
    let app;
    try {
      app = await this.conversion.convert(code);
    } catch (err) {
      this.logger.warn(`GitHub App manifest conversion failed: ${(err as Error).message}`);
      return retry("GitHub did not return the App: the code has expired or was already used.");
    }
    const installUrl = `${app.html_url}/installations/new`;
    this.logger.log(`GitHub App "${app.slug}" created for ${app.owner?.login ?? "?"}`);
    return page(`<p>✅ GitHub App <b>${escapeHtml(app.slug)}</b> is created.
This page is the only time its private key and secrets are shown.</p>
<ol>
<li>Add these lines to <code>.env</code>:<pre>${escapeHtml(envBlock(app))}</pre></li>
<li>Restart the server: <code>docker compose --profile app up -d</code>.</li>
<li><a href="${escapeHtml(installUrl)}">Install the App</a> on ${escapeHtml(app.owner?.login ?? "your organization")} — it becomes your Callog workspace.</li>
<li>Open <a href="/">Callog</a> and sign in with GitHub.</li>
</ol>
<p><small>Lost the key? Generate a new one and new secrets in the App's settings on GitHub.</small></p>`);
  }

  private get publicUrl(): string {
    return this.env.PUBLIC_URL!.replace(/\/+$/, "");
  }

  private get secureCookies(): boolean {
    return this.env.PUBLIC_URL?.startsWith("https://") ?? false;
  }

  private cookieOptions(maxAgeSeconds: number) {
    return { maxAgeSeconds, secure: this.secureCookies };
  }

  /** Once the App is configured the flow is gone: it never replaces a working App. */
  private ensureNotConfigured(): void {
    if (this.app) throw new NotFoundException();
  }

  private pageHeaders(reply: FastifyReply): void {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", PAGE_CSP)
      .header("referrer-policy", "no-referrer");
  }
}

function page(body: string): string {
  return htmlDocument(`<h1>Set up Callog</h1>${body}`);
}

function retry(message: string): string {
  return page(`<p>⚠️ ${escapeHtml(message)}</p><p><a href="${SETUP_PATH}">Start over</a></p>`);
}
