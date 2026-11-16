import { recipientSchema, type Route } from "@callog/config-schema";
import { createPlainEngine, renderAt, renderString, type RenderContext } from "./engine";

/**
 * What makes two notifications of a route "the same", or `undefined` when the route does
 * not group or its key renders to nothing.
 */
export function renderGroupKey(route: Route, data: Record<string, unknown>): string | undefined {
  const { group } = route;
  if (!group) return undefined;
  const key = renderAt(["group", "key"], () =>
    renderString(createPlainEngine(), group.key, dataContext(route, data)),
  ).trim();
  return key || undefined;
}

/**
 * The recipients a route adds on its own, from the notification's data. An expression that
 * renders to nothing, or to something that is not a recipient (`github:` for a missing
 * login), adds nobody: the sender cannot fix its payload, so this never fails a request.
 * A broken expression is a `TemplateRenderError`, caught when the config is validated.
 */
export function renderRouteRecipients(route: Route, data: Record<string, unknown>): string[] {
  const engine = createPlainEngine();
  const ctx = dataContext(route, data);
  const found = new Set<string>();
  route.recipients.forEach((source, i) => {
    const rendered = renderAt(["recipients", i], () => renderString(engine, source, ctx));
    for (const candidate of rendered.split(/[\s,]+/)) {
      const recipient = recipientSchema.safeParse(candidate);
      if (recipient.success) found.add(recipient.data);
    }
  });
  return [...found];
}

/** What a route's own expressions see: the data, and no recipients yet. */
function dataContext(route: Route, data: Record<string, unknown>): RenderContext {
  return { data, recipients: [], route: { id: route.id } };
}
