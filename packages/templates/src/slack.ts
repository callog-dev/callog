import type { Route } from "@callog/config-schema";
import { BLOCK_TYPES, renderBlocks, type RenderedBlock } from "./blocks";
import {
  TemplateRenderError,
  type MentionResolver,
  type RenderInput,
  type RenderResult,
} from "./engine";
import type { MarkdownTarget } from "./markdown";

/** Slack requires only these three characters to be escaped in text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const slackMarkdown: MarkdownTarget = {
  escape: escapeSlack,
  bold: (s) => `*${s}*`,
  italic: (s) => `_${s}_`,
  strike: (s) => `~${s}~`,
  code: (s) => `\`${s}\``,
  link: (text, url) => `<${url}|${text}>`,
};

// Block Kit limits.
const MAX_HEADER = 150;
const MAX_TEXT = 3000;
const MAX_FIELDS = 10;
const MAX_FIELD_TEXT = 2000;
const MAX_ACTIONS = 25;
const MAX_ACTION_TEXT = 75;
const MAX_BLOCKS = 50;

export type SlackBlock = Record<string, unknown>;

export interface SlackMessage {
  /** Fallback text for notifications and clients without Block Kit. */
  text: string;
  blocks: SlackBlock[];
}

export interface SlackRenderOptions {
  mention?: MentionResolver;
}

/** Slack draws every block itself, as Block Kit. */
export function renderSlack(
  route: Route,
  input: RenderInput,
  options: SlackRenderOptions = {},
): RenderResult<SlackMessage> {
  const { message, unmapped } = renderBlocks(route, input, {
    target: slackMarkdown,
    native: BLOCK_TYPES,
    limits: { fields: MAX_FIELDS, actions: MAX_ACTIONS },
    mention: options.mention,
  });
  if (message.length > MAX_BLOCKS) {
    throw new TemplateRenderError(["template"], `Slack allows at most ${MAX_BLOCKS} blocks`);
  }
  const blocks = message.map(toSlackBlock);
  return { message: { text: fallbackText(blocks), blocks }, unmapped };
}

function toSlackBlock(block: RenderedBlock): SlackBlock {
  switch (block.type) {
    case "header":
      return {
        type: "header",
        text: { type: "plain_text", text: truncate(block.text, MAX_HEADER), emoji: true },
      };
    case "text":
      return { type: "section", text: { type: "mrkdwn", text: truncate(block.text, MAX_TEXT) } };
    case "fields":
      return {
        type: "section",
        fields: block.fields.map((field) => ({
          type: "mrkdwn",
          text: truncate(`*${escapeSlack(field.label)}*\n${field.value}`, MAX_FIELD_TEXT),
        })),
      };
    case "context":
      return {
        type: "context",
        elements: [{ type: "mrkdwn", text: truncate(block.text, MAX_TEXT) }],
      };
    case "divider":
      return { type: "divider" };
    case "actions":
      return {
        type: "actions",
        elements: block.actions.map((action) => ({
          type: "button",
          text: { type: "plain_text", text: truncate(action.text, MAX_ACTION_TEXT), emoji: true },
          url: action.url,
        })),
      };
  }
}

/**
 * Slack parses the top-level `text` as mrkdwn, so text taken from an unescaped
 * plain_text block (a header) is escaped here.
 */
function fallbackText(blocks: SlackBlock[]): string {
  for (const block of blocks) {
    const { type, text } = (block.text ?? {}) as { type?: unknown; text?: unknown };
    if (typeof text === "string" && text.trim()) {
      return truncate(type === "plain_text" ? escapeSlack(text) : text, MAX_TEXT);
    }
  }
  return "Notification";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
