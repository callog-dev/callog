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
import { renderMarkdown, type MarkdownTarget } from "./markdown";

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
const MAX_BUTTONS = 25;
const MAX_BUTTON_TEXT = 75;
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

export function renderSlack(
  route: Route,
  input: RenderInput,
  options: SlackRenderOptions = {},
): RenderResult<SlackMessage> {
  const unmapped = new Set<Ref>();
  const mention = route.mentions === "none" ? undefined : options.mention;
  const escaped = createEngine({ escape: escapeSlack, mention, unmapped });
  // plain_text fields are not parsed by Slack, so their outputs are not escaped.
  const plain = createEngine({ escape: (s) => s, mention, unmapped });
  const ctx: RenderContext = { ...input, route: { id: route.id } };

  const mrkdwn = (path: (string | number)[], source: string) =>
    renderAt(path, () => renderMarkdown(escaped, source, slackMarkdown, ctx));
  const plainText = (path: (string | number)[], source: string) =>
    renderAt(path, () => renderString(plain, source, ctx));

  let blocks: SlackBlock[];
  if (route.slack_blocks) {
    blocks = route.slack_blocks.map(
      (block, i) =>
        renderDeep(block, (s, p) =>
          renderAt(["slack_blocks", i, ...p], () => renderString(escaped, s, ctx)),
        ) as SlackBlock,
    );
  } else {
    blocks = (route.template ?? []).map((block, i) =>
      toSlackBlock(block, ["template", i], mrkdwn, plainText),
    );
  }
  if (blocks.length > MAX_BLOCKS) {
    throw new TemplateRenderError(["template"], `Slack allows at most ${MAX_BLOCKS} blocks`);
  }

  // Raw slack_blocks were rendered with escaping everywhere, including plain_text.
  const fallback = fallbackText(blocks, route.slack_blocks ? (t) => t : escapeSlack);
  return { message: { text: fallback, blocks }, unmapped: [...unmapped] };
}

type Renderer = (path: (string | number)[], source: string) => string;

function toSlackBlock(
  block: Block,
  path: (string | number)[],
  mrkdwn: Renderer,
  plainText: Renderer,
): SlackBlock {
  if ("header" in block) {
    return {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(plainText([...path, "header"], block.header), MAX_HEADER),
        emoji: true,
      },
    };
  }
  if ("text" in block) {
    return {
      type: "section",
      text: { type: "mrkdwn", text: truncate(mrkdwn([...path, "text"], block.text), MAX_TEXT) },
    };
  }
  if ("fields" in block) {
    return {
      type: "section",
      fields: block.fields.slice(0, MAX_FIELDS).map((field, i) => ({
        type: "mrkdwn",
        text: truncate(
          `*${escapeSlack(field.label)}*\n${mrkdwn([...path, "fields", i, "value"], field.value)}`,
          2000,
        ),
      })),
    };
  }
  if ("buttons" in block) {
    return {
      type: "actions",
      elements: block.buttons.slice(0, MAX_BUTTONS).map((button, i) => {
        const urlPath = [...path, "buttons", i, "url"];
        const url = httpUrl(urlPath, plainText(urlPath, button.url));
        return {
          type: "button",
          text: {
            type: "plain_text",
            text: truncate(
              plainText([...path, "buttons", i, "text"], button.text),
              MAX_BUTTON_TEXT,
            ),
            emoji: true,
          },
          url,
        };
      }),
    };
  }
  if ("context" in block) {
    return {
      type: "context",
      elements: [
        { type: "mrkdwn", text: truncate(mrkdwn([...path, "context"], block.context), MAX_TEXT) },
      ],
    };
  }
  return { type: "divider" };
}

/** Applies `render` to every string inside raw Block Kit JSON. */
function renderDeep(
  value: unknown,
  render: (source: string, path: (string | number)[]) => string,
  path: (string | number)[] = [],
): unknown {
  if (typeof value === "string") return render(value, path);
  if (Array.isArray(value)) return value.map((v, i) => renderDeep(v, render, [...path, i]));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderDeep(v, render, [...path, k])]),
    );
  }
  return value;
}

/**
 * Slack parses the top-level `text` as mrkdwn, so text taken from an unescaped
 * plain_text block (a header) is escaped here.
 */
function fallbackText(blocks: SlackBlock[], escapePlain: (text: string) => string): string {
  for (const block of blocks) {
    const { type, text } = (block.text ?? {}) as { type?: unknown; text?: unknown };
    if (typeof text === "string" && text.trim()) {
      return truncate(type === "plain_text" ? escapePlain(text) : text, MAX_TEXT);
    }
  }
  return "Notification";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
