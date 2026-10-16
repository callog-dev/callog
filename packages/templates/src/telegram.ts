import type { Block, Ref, Route } from "@callog/config-schema";
import {
  createEngine,
  httpUrl,
  renderAt,
  renderString,
  TemplateRenderError,
  type MentionResolver,
  type RenderContext,
  type RenderInput,
  type RenderResult,
} from "./engine";
import { escapeLiterals, renderMarkdown, type MarkdownTarget } from "./markdown";

/** Telegram HTML parse mode needs only these escaped (core.telegram.org/bots/api#html-style). */
export function escapeTelegram(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const telegramMarkdown: MarkdownTarget = {
  escape: escapeTelegram,
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  strike: (s) => `<s>${s}</s>`,
  code: (s) => `<code>${s}</code>`,
  link: (text, url) => `<a href="${url.replace(/"/g, "&quot;")}">${text}</a>`,
};

const MAX_TEXT = 4096;
const BUTTONS_PER_ROW = 3;
const MAX_BUTTON_TEXT = 64;

export interface TelegramButton {
  text: string;
  url: string;
}

export interface TelegramMessage {
  /** HTML (parse_mode=HTML). */
  text: string;
  /** inline_keyboard rows */
  buttons: TelegramButton[][];
}

export interface TelegramRenderOptions {
  mention?: MentionResolver;
}

/**
 * Renders a route's neutral template to a Telegram HTML message. Raw
 * `slack_blocks` are Slack-only; config validation requires `template` for Telegram.
 */
export function renderTelegram(
  route: Route,
  input: RenderInput,
  options: TelegramRenderOptions = {},
): RenderResult<TelegramMessage> {
  if (!route.template) {
    throw new TemplateRenderError(
      ["template"],
      "Telegram needs a template (slack_blocks are Slack-only)",
    );
  }
  const unmapped = new Set<Ref>();
  const mention = route.mentions === "none" ? undefined : options.mention;
  const escaped = createEngine({ escape: escapeTelegram, mention, unmapped });
  const raw = createEngine({ escape: (s) => s, mention, unmapped });
  const ctx: RenderContext = { ...input, route: { id: route.id } };

  const html = (path: (string | number)[], source: string) =>
    renderAt(path, () => renderMarkdown(escaped, source, telegramMarkdown, ctx));
  const plain = (path: (string | number)[], source: string) =>
    renderAt(path, () => renderString(escaped, escapeLiterals(source, escapeTelegram), ctx));
  const url = (path: (string | number)[], source: string) =>
    httpUrl(
      path,
      renderAt(path, () => renderString(raw, source, ctx)),
    );

  const parts: string[] = [];
  const buttons: TelegramButton[] = [];
  route.template.forEach((block: Block, i) => {
    const path = ["template", i];
    if ("header" in block) parts.push(`<b>${plain([...path, "header"], block.header)}</b>`);
    else if ("text" in block) parts.push(html([...path, "text"], block.text));
    else if ("fields" in block) {
      parts.push(
        block.fields
          .map(
            (f, j) =>
              `<b>${escapeTelegram(f.label)}:</b> ${html([...path, "fields", j, "value"], f.value)}`,
          )
          .join("\n"),
      );
    } else if ("buttons" in block) {
      block.buttons.forEach((b, j) => {
        const text = renderAt([...path, "buttons", j, "text"], () =>
          renderString(raw, b.text, ctx),
        );
        buttons.push({
          text: text.slice(0, MAX_BUTTON_TEXT),
          url: url([...path, "buttons", j, "url"], b.url),
        });
      });
    } else if ("context" in block)
      parts.push(`<i>${html([...path, "context"], block.context)}</i>`);
    else parts.push("———");
  });

  return {
    message: { text: fitText(parts), buttons: chunk(buttons, BUTTONS_PER_ROW) },
    unmapped: [...unmapped],
  };
}

/** Drops trailing blocks rather than cutting HTML mid-tag when over Telegram's limit. */
function fitText(parts: string[]): string {
  const joined = parts.join("\n\n");
  if (joined.length <= MAX_TEXT) return joined || "Notification";
  let text = "";
  for (const part of parts) {
    const next = text ? `${text}\n\n${part}` : part;
    if (next.length > MAX_TEXT - 2) break;
    text = next;
  }
  return `${text || cutAsPlainText(parts[0]!, MAX_TEXT - 2)}\n…`;
}

/** The first `max` characters of an HTML part without its tags or a cut entity. */
function cutAsPlainText(html: string, max: number): string {
  return html
    .replace(/<[^>]*>/g, "")
    .slice(0, max)
    .replace(/&[^;\s]*$/, "");
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
