import type { Liquid } from "liquidjs";
import { HTTP_URL, renderString, type RenderContext } from "./engine";

// The neutral "limited markdown" of template text blocks:
// **bold**, _italic_, ~~strike~~, `code`, [text](url).
// Conversion runs on the template source before Liquid, so data inserted by
// `{{ … }}` is never interpreted as markdown.

// Placeholders use Private Use Area characters that never appear in real templates
// (the engine strips them from data).
const LIQUID_TAG = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;
const PLACEHOLDER = /\uE000(\d+)\uE000/g;
// A link whose URL contains Liquid: `\uE002url\uE003text\uE004`, built by finishLinks.
const PENDING_LINK = /\uE002([^\uE003\uE004]*)\uE003([^\uE004]*)\uE004/g;

export interface MarkdownTarget {
  /** Escapes literal template text for the target markup. */
  escape: (text: string) => string;
  bold: (inner: string) => string;
  italic: (inner: string) => string;
  strike: (inner: string) => string;
  code: (inner: string) => string;
  link: (text: string, url: string) => string;
}

/** Replaces Liquid tags with placeholders, transforms the rest, then puts the tags back. */
function outsideLiquid(source: string, transform: (masked: string) => string): string {
  const tags: string[] = [];
  const masked = source.replace(LIQUID_TAG, (tag) => `\uE000${tags.push(tag) - 1}\uE000`);
  return transform(masked).replace(PLACEHOLDER, (_, i: string) => tags[Number(i)]!);
}

function convertMarkdown(source: string, target: MarkdownTarget): string {
  return outsideLiquid(source, (masked) => convertMasked(masked, target));
}

function convertMasked(masked: string, target: MarkdownTarget): string {
  // Code spans first: their content is escaped but not otherwise formatted.
  const codeSpans: string[] = [];
  const withoutCode = masked.replace(/`([^`\n]+)`/g, (_, inner: string) => {
    codeSpans.push(target.code(target.escape(inner)));
    return `\uE001${codeSpans.length - 1}\uE001`;
  });

  return target
    .escape(withoutCode)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) =>
      url.includes("\uE000") ? `\uE002${url}\uE003${text}\uE004` : target.link(text, url),
    )
    .replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => target.bold(inner))
    .replace(/~~([^~\n]+)~~/g, (_, inner: string) => target.strike(inner))
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, (_, pre: string, inner: string) => {
      return pre + target.italic(inner);
    })
    .replace(/\uE001(\d+)\uE001/g, (_, i: string) => codeSpans[Number(i)]!);
}

/**
 * Builds the links whose URL came from data, after Liquid rendering: data must not break
 * out of the link markup (`|` in Slack, `"` in HTML) or point anywhere but http(s).
 * A link with an unusable URL is rendered as its text.
 */
function finishLinks(rendered: string, target: MarkdownTarget): string {
  return rendered.replace(PENDING_LINK, (_, url: string, text: string) => {
    const safe = url.trim().replace(/"/g, "%22").replace(/\|/g, "%7C");
    return HTTP_URL.test(safe) ? target.link(text, safe) : text;
  });
}

/** Renders a template text block: markdown for the target, escaped data, finished links. */
export function renderMarkdown(
  engine: Liquid,
  source: string,
  target: MarkdownTarget,
  ctx: RenderContext,
): string {
  return finishLinks(renderString(engine, convertMarkdown(source, target), ctx), target);
}

/** Escapes the literal text of a template while leaving Liquid tags untouched. */
export function escapeLiterals(source: string, escape: (text: string) => string): string {
  return outsideLiquid(source, escape);
}
