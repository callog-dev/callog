import {
  parseConfigTree,
  type ConfigIssue,
  type ConfigTree,
  type ParseResult,
  type Route,
} from "@callog/config-schema";
import { TemplateRenderError } from "./engine";
import { renderSlack } from "./slack";
import { renderTelegram } from "./telegram";

export interface TemplateIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Renders every example of a route (or an empty context when there are none) and
 * reports template errors. Used by `notify validate`.
 */
export function validateRouteTemplates(route: Route): TemplateIssue[] {
  const inputs = route.examples.length > 0 ? route.examples : [{ data: {}, recipients: [] }];
  const issues: TemplateIssue[] = [];
  inputs.forEach((input, i) => {
    try {
      renderSlack(route, input);
      // Without a neutral template the route cannot target Telegram (config-schema enforces it).
      if (route.template) renderTelegram(route, input);
    } catch (err) {
      if (!(err instanceof TemplateRenderError)) throw err;
      const prefix = route.examples.length > 0 ? `example ${i}: ` : "";
      issues.push({ path: err.path, message: prefix + err.reason });
    }
  });
  return issues;
}

/**
 * Everything a config repo must pass — shared by `notify validate` (CI) and the server's
 * config loader, so a green check means the server accepts the config:
 * schema and cross-file rules, route data schemas and examples, and template rendering.
 */
export function validateConfigTree(tree: ConfigTree): ParseResult {
  const result = parseConfigTree(tree);
  if (!result.ok) return result;
  const errors: ConfigIssue[] = [];
  for (const route of Object.values(result.config.routes)) {
    for (const issue of validateRouteTemplates(route)) {
      errors.push({ file: result.routeFiles[route.id]!, path: issue.path, message: issue.message });
    }
  }
  return errors.length > 0 ? { ok: false, errors, warnings: result.warnings } : result;
}
