import type { Route } from "@callog/config-schema";
import { renderBlocks } from "./blocks";
import type { MentionResolver, RenderInput, RenderResult } from "./engine";
import type { MarkdownTarget } from "./markdown";

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

/** Telegram has text and an inline keyboard; every other block arrives as text. */
const NATIVE_BLOCKS = ["text", "actions"] as const;

/** Renders a route's template to a Telegram HTML message. */
export function renderTelegram(
  route: Route,
  input: RenderInput,
  options: TelegramRenderOptions = {},
): RenderResult<TelegramMessage> {
  const { message, unmapped } = renderBlocks(route, input, {
    target: telegramMarkdown,
    native: NATIVE_BLOCKS,
    mention: options.mention,
  });
  const parts: string[] = [];
  const buttons: TelegramButton[] = [];
  for (const block of message) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "actions":
        for (const { text, url } of block.actions) {
          buttons.push({ text: text.slice(0, MAX_BUTTON_TEXT), url });
        }
    }
  }
  return { message: { text: fitText(parts), buttons: chunk(buttons, BUTTONS_PER_ROW) }, unmapped };
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
