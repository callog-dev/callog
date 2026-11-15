import type { Block, Ref, Route } from "@callog/config-schema";
import {
  createEngine,
  httpUrl,
  renderAt,
  renderString,
  type MentionResolver,
  type RenderContext,
  type RenderInput,
  type RenderResult,
} from "./engine";
import { renderMarkdown, safeLinkUrl, type MarkdownTarget } from "./markdown";

/**
 * A template block after Liquid: `text`, `value` and context strings are in the target's
 * markup with data escaped; header, label and action strings are plain and unescaped.
 */
export type RenderedBlock =
  | { type: "header"; text: string }
  | { type: "text"; text: string }
  | { type: "fields"; fields: { label: string; value: string }[] }
  | { type: "context"; text: string }
  | { type: "divider" }
  | { type: "actions"; actions: { text: string; url: string }[] };

export type BlockType = RenderedBlock["type"];

export const BLOCK_TYPES = [
  "header",
  "text",
  "fields",
  "context",
  "divider",
  "actions",
] as const satisfies readonly BlockType[];

export interface BlockRenderOptions<Native extends BlockType> {
  /** How the channel writes inline formatting. */
  target: MarkdownTarget;
  /** Blocks the channel draws itself; every other block arrives as a `text` block. */
  native: readonly Native[];
  /** The most fields and actions the channel shows in one block; the rest are left out. */
  limits?: { fields?: number; actions?: number };
  mention?: MentionResolver;
}

/** What a channel gets: its native blocks as they are, the others as text. */
export type ChannelBlock<Native extends BlockType> = Extract<
  RenderedBlock,
  { type: Native | "text" }
>;

/**
 * Renders a route's template for one channel. The channel names its markup and the blocks
 * it can draw; the rest are turned into text here, so a channel that only sends text
 * still shows every block.
 */
export function renderBlocks<Native extends BlockType>(
  route: Route,
  input: RenderInput,
  { target, native, limits = {}, mention }: BlockRenderOptions<Native>,
): RenderResult<ChannelBlock<Native>[]> {
  const unmapped = new Set<Ref>();
  const ctx: RenderContext = { ...input, route: { id: route.id } };
  const formatted = createEngine({
    escape: target.escape,
    mention: route.mentions === "none" ? undefined : mention,
    unmapped,
  });
  // Plain strings cannot hold mention markup: a mention there is the person's name, and
  // says nothing about whether the person has an account in the channel.
  const unformatted = createEngine({
    escape: (text) => text,
    mention: undefined,
    unmapped: new Set(),
  });
  const render: BlockStrings = {
    markup: (path, source) => renderAt(path, () => renderMarkdown(formatted, source, target, ctx)),
    plain: (path, source) => renderAt(path, () => renderString(unformatted, source, ctx)),
  };

  const isNative = (block: RenderedBlock): block is ChannelBlock<Native> =>
    (native as readonly BlockType[]).includes(block.type);
  const blocks = route.template.map((block, i): ChannelBlock<Native> => {
    const rendered = renderBlock(block, ["template", i], render, limits);
    return isNative(rendered) ? rendered : { type: "text", text: blockAsText(rendered, target) };
  });
  return { message: blocks, unmapped: [...unmapped] };
}

type Path = (string | number)[];

interface BlockStrings {
  markup(path: Path, source: string): string;
  plain(path: Path, source: string): string;
}

function renderBlock(
  block: Block,
  path: Path,
  render: BlockStrings,
  limits: { fields?: number; actions?: number },
): RenderedBlock {
  if ("header" in block) {
    return { type: "header", text: render.plain([...path, "header"], block.header) };
  }
  if ("text" in block) {
    return { type: "text", text: render.markup([...path, "text"], block.text) };
  }
  if ("fields" in block) {
    return {
      type: "fields",
      fields: block.fields.slice(0, limits.fields).map((field, i) => ({
        label: field.label,
        value: render.markup([...path, "fields", i, "value"], field.value),
      })),
    };
  }
  if ("context" in block) {
    return { type: "context", text: render.markup([...path, "context"], block.context) };
  }
  if ("actions" in block) {
    return {
      type: "actions",
      actions: block.actions.slice(0, limits.actions).map((action, i) => {
        const urlPath = [...path, "actions", i, "url"];
        return {
          text: render.plain([...path, "actions", i, "text"], action.text),
          url: httpUrl(urlPath, render.plain(urlPath, action.url)),
        };
      }),
    };
  }
  return { type: "divider" };
}

/** A block the channel cannot draw, as text in the channel's markup. */
function blockAsText(block: RenderedBlock, target: MarkdownTarget): string {
  switch (block.type) {
    case "header":
      return target.bold(target.escape(block.text));
    case "text":
      return block.text;
    case "fields":
      return block.fields
        .map((field) => `${target.bold(target.escape(`${field.label}:`))} ${field.value}`)
        .join("\n");
    case "context":
      return target.italic(block.text);
    case "divider":
      return "———";
    case "actions":
      return block.actions
        .map((action) => target.link(target.escape(action.text), safeLinkUrl(action.url)))
        .join(" · ");
  }
}
