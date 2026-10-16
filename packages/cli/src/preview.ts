import { ownValue, type Config, type Route } from "@callog/config-schema";
import {
  renderSlack,
  renderTelegram,
  TemplateRenderError,
  type SlackBlock,
  type TelegramMessage,
} from "@callog/templates";

export const PREVIEW_MARKER = "<!-- callog:preview -->";

/**
 * Markdown preview of routes' examples as they will look in Slack and Telegram.
 * Mentions render as plain names: CI does not know who is who.
 */
export function previewMarkdown(
  config: Config,
  routeIds: string[],
  files: Record<string, string> = {},
): string {
  const parts = [PREVIEW_MARKER, "## 🔔 notify preview", ""];
  if (routeIds.length === 0) {
    parts.push("_No routes changed in this pull request._");
    return parts.join("\n");
  }
  parts.push("_Mentions show as plain names here; real ones resolve to people when sent._", "");
  for (const id of routeIds) {
    const route = ownValue(config.routes, id);
    if (!route) continue;
    parts.push(...routeSection(route, config, files[id]));
  }
  return parts.join("\n");
}

function routeSection(route: Route, config: Config, file?: string): string[] {
  const lines = [`### \`${route.id}\`${route.description ? ` — ${route.description}` : ""}`, ""];
  const targets = route.destinations.map((d) =>
    "slack" in d
      ? `Slack ${d.slack}`
      : "telegram" in d
        ? `Telegram ${d.telegram}`
        : `team ${d.team}${teamChannels(config, d.team)}`,
  );
  lines.push(`**To:** ${targets.join(", ")}${route.dm ? " · personal copies to recipients" : ""}`);
  const sources = [
    ...route.allowed_sources.github_repos.map((r) => `\`${r}\``),
    ...route.allowed_sources.api_keys.map((k) => `key \`${k}\``),
  ];
  lines.push(`**From:** ${sources.join(", ")}`, "");

  const examples = route.examples.length > 0 ? route.examples : [{ data: {}, recipients: [] }];
  const toTelegram = route.template && reachesTelegram(route, config);
  examples.forEach((example, i) => {
    if (route.examples.length > 1) lines.push(`#### Example ${i + 1}`, "");
    try {
      const slack = renderSlack(route, example).message;
      lines.push(
        `<details open><summary>Slack · <a href="${blockKitBuilderUrl(slack.blocks)}">open in Block Kit Builder</a></summary>`,
        "",
        quote(slackBlocksToMarkdown(slack.blocks)),
        "",
        "</details>",
        "",
      );
      if (toTelegram) {
        lines.push(
          "<details open><summary>Telegram</summary>",
          "",
          quote(telegramToMarkdown(renderTelegram(route, example).message)),
          "",
          "</details>",
          "",
        );
      }
    } catch (err) {
      const message = err instanceof TemplateRenderError ? err.message : String(err);
      lines.push(`> ⚠️ Cannot render: ${message}`, "");
    }
  });
  if (route.examples.length === 0) {
    lines.push(
      `_Add \`examples\` to ${file ? `\`${file}\`` : "the route"} to preview it with real data._`,
      "",
    );
  }
  return lines;
}

function teamChannels(config: Config, slug: string): string {
  const team = ownValue(config.teams, slug);
  const channels = [team?.slack_channel, team?.telegram_chat].filter(Boolean);
  return channels.length ? ` (${channels.join(", ")})` : "";
}

function reachesTelegram(route: Route, config: Config): boolean {
  return route.destinations.some(
    (d) =>
      "telegram" in d || ("team" in d && Boolean(ownValue(config.teams, d.team)?.telegram_chat)),
  );
}

/** Exact rendering lives in Slack's builder; the link carries the blocks in the URL fragment. */
export function blockKitBuilderUrl(blocks: SlackBlock[]): string {
  return `https://app.slack.com/block-kit-builder#${encodeURIComponent(JSON.stringify({ blocks }))}`;
}

/**
 * Rendered text keeps its HTML entities (&lt; &gt; &amp;): GitHub displays them as the
 * characters, and data from examples can never turn into markup in the comment.
 */
const keepEntities = (s: string) => s.replace(/&quot;/g, '"');

/** Approximates Slack mrkdwn in GitHub markdown. */
function mrkdwn(text: string): string {
  return keepEntities(
    text
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<@(\w+)>/g, "@$1")
      .replace(/<!subteam\^(\w+)>/g, "@group")
      .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1**$2**")
      .replace(/~([^~\n]+)~/g, "~~$1~~"),
  );
}

export function slackBlocksToMarkdown(blocks: SlackBlock[]): string {
  const out: string[] = [];
  for (const block of blocks as { type: string; [k: string]: unknown }[]) {
    const text = (block.text as { text?: string } | undefined)?.text;
    switch (block.type) {
      case "header":
        out.push(`**${text ?? ""}**`);
        break;
      case "section":
        if (text) out.push(mrkdwn(text));
        for (const f of (block.fields as { text: string }[] | undefined) ?? [])
          out.push(mrkdwn(f.text).replace(/\n/, " — "));
        break;
      case "context":
        out.push(
          `<sub>${((block.elements as { text?: string }[]) ?? []).map((e) => mrkdwn(e.text ?? "")).join(" ")}</sub>`,
        );
        break;
      case "actions":
        out.push(
          ((block.elements as { text: { text: string }; url?: string }[]) ?? [])
            .map((b) => `[\`${b.text.text}\`](${b.url ?? "#"})`)
            .join(" "),
        );
        break;
      case "divider":
        out.push("———");
        break;
      default:
        out.push(`_(${block.type} block)_`);
    }
  }
  return out.join("\n\n");
}

export function telegramToMarkdown(message: TelegramMessage): string {
  const body = keepEntities(
    message.text
      .replace(/<b>([\s\S]*?)<\/b>/g, "**$1**")
      .replace(/<i>([\s\S]*?)<\/i>/g, "_$1_")
      .replace(/<s>([\s\S]*?)<\/s>/g, "~~$1~~")
      .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
      .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, "[$2]($1)"),
  );
  const buttons = message.buttons
    .flat()
    .map((b) => `[\`${b.text}\`](${b.url})`)
    .join(" ");
  return buttons ? `${body}\n\n${buttons}` : body;
}

/** Quotes a rendered message; `@login` from data would ping that GitHub user, so it is broken. */
function quote(md: string): string {
  return md
    .replace(/(^|[^\w`])@(?=\w)/g, "$1@\u200B")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}
