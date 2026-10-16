import { Liquid } from "liquidjs";
import type { Ref } from "@callog/config-schema";

/** Output that must not be escaped again (e.g. mention markup produced by a resolver). */
export class SafeString {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * Turns a recipient ref into provider mention markup — one entry per mentioned account
 * (a team yields its members) — or `undefined` when the ref cannot be resolved for this
 * provider. Implemented by the server with pre-resolved identities, so it
 * is synchronous.
 */
export type MentionResolver = (ref: Ref) => string | readonly string[] | undefined;

export interface RenderInput {
  data: Record<string, unknown>;
  recipients: Ref[];
}

export interface RenderResult<M> {
  message: M;
  /** Recipient refs rendered as plain text because they have no identity for this provider. */
  unmapped: Ref[];
}

export class TemplateRenderError extends Error {
  constructor(
    readonly path: (string | number)[],
    /** The problem itself; `message` is prefixed with the path. */
    readonly reason: string,
  ) {
    super(`${path.join(".")}: ${reason}`);
    this.name = "TemplateRenderError";
  }
}

/** Runs one render step; any failure is reported at `path` of the route. */
export function renderAt(path: (string | number)[], render: () => string): string {
  try {
    return render();
  } catch (err) {
    if (err instanceof TemplateRenderError) throw err;
    throw new TemplateRenderError(path, err instanceof Error ? err.message : String(err));
  }
}

/** URLs that come from data must be http(s) (buttons and markdown links). */
export const HTTP_URL = /^https?:\/\/\S+$/i;
/** Private Use Area characters markdown.ts uses as placeholders; never taken from data. */
const PLACEHOLDER_CHARS = /[\uE000-\uE004]/g;

/** Button URLs must render to http(s) — anything else is a template error. */
export function httpUrl(path: (string | number)[], rendered: string): string {
  const url = rendered.trim();
  if (!HTTP_URL.test(url)) {
    throw new TemplateRenderError(path, `rendered URL must be http(s), got "${url}"`);
  }
  return url;
}

export interface RenderContext {
  data: Record<string, unknown>;
  recipients: Ref[];
  route: { id: string };
}

export interface EngineOptions {
  escape: (text: string) => string;
  mention: MentionResolver | undefined;
  /** Collects refs that fell back to plain text. */
  unmapped: Set<Ref>;
}

const LIMITS = {
  parseLimit: 1e5, // template source characters
  renderLimit: 200, // ms per render
  memoryLimit: 1e7, // allocated characters / array items
};

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringify).join("");
  if (typeof value === "object" && !(value instanceof SafeString)) return JSON.stringify(value);
  return String(value);
}

/** The visible part of a ref: `github:octocat` → `octocat`. */
function plainName(ref: string): string {
  const i = ref.indexOf(":");
  return i === -1 ? ref : ref.slice(i + 1);
}

/**
 * A sandboxed Liquid engine: no file access (partials disabled), CPU/memory limits,
 * every `{{ output }}` escaped for the target provider unless it is a SafeString.
 */
export function createEngine(options: EngineOptions): Liquid {
  const engine = new Liquid({
    ...LIMITS,
    ownPropertyOnly: true,
    strictFilters: true,
    outputEscape: (value: unknown) =>
      value instanceof SafeString
        ? value.value
        : options.escape(stringify(value).replace(PLACEHOLDER_CHARS, "")),
  });

  for (const tag of ["include", "render", "layout"]) {
    engine.registerTag(tag, {
      parse() {
        throw new Error(`{% ${tag} %} is not supported in notification templates`);
      },
      render() {},
    });
  }

  engine.registerFilter("mention", (input: unknown) => {
    const refs = (Array.isArray(input) ? input : [input]).filter(
      (r): r is Ref => typeof r === "string" && r.length > 0,
    );
    // A person mentioned both directly and via a team appears once, at first sight.
    const parts = new Set<string>();
    for (const ref of refs) {
      const markup = options.mention?.(ref);
      if (markup === undefined) {
        options.unmapped.add(ref);
        parts.add(options.escape(plainName(ref)));
      } else if (typeof markup === "string") {
        parts.add(markup);
      } else {
        for (const m of markup) parts.add(m);
      }
    }
    return new SafeString([...parts].join(", "));
  });

  return engine;
}

export function renderString(engine: Liquid, source: string, ctx: RenderContext): string {
  return engine.parseAndRenderSync(source, ctx);
}
