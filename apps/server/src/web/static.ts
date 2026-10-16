import { Controller, Get, NotFoundException, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ServeStaticModule } from "@nestjs/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Built SPA (`apps/web/dist`); in the container it is copied to WEB_DIST_DIR. */
const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? path.resolve(__dirname, "../../../web/dist");
const HAS_WEB_BUILD = existsSync(path.join(WEB_DIST_DIR, "index.html"));

/** Server routes the SPA fallback must never swallow. */
const SERVER_PREFIXES = new Set([
  "api",
  "v1",
  "admin",
  "auth",
  "oauth",
  "webhooks",
  "metrics",
  "healthz",
  "readyz",
]);

/**
 * index.html for client-side routes (`/routes`, `/me`, …). Static files are exact routes
 * registered by @fastify/static, so they win over this wildcard.
 */
@Controller()
export class SpaController {
  private readonly html = readFileSync(path.join(WEB_DIST_DIR, "index.html"), "utf8");

  // Fastify's own wildcard syntax (the adapter passes it through).
  @Get("*")
  index(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): string {
    const first = req.url.split("?")[0]!.split("/")[1] ?? "";
    if (SERVER_PREFIXES.has(first)) throw new NotFoundException();
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      // The UI has buttons with side effects (mute, unlink, API keys): never inside a frame.
      .header("content-security-policy", "frame-ancestors 'none'");
    return this.html;
  }
}

/** Serves the web UI when it is built; without a build the server runs API-only. */
export function webUiModule() {
  if (!HAS_WEB_BUILD) return [];
  return [
    ServeStaticModule.forRoot({
      rootPath: WEB_DIST_DIR,
      // Fallback rendering is done by SpaController; keep the built-in one out of the way.
      renderPath: "/__notify_static_index",
    }),
  ];
}

export const spaControllers = () => (HAS_WEB_BUILD ? [SpaController] : []);
