#!/usr/bin/env node
import { parseArgs } from "node:util";
import { validateConfigTree } from "@callog/templates";
import { readConfigDir } from "./files";
import { previewMarkdown } from "./preview";
import { send } from "./send";
import { validate } from "./validate";

const HELP = `notify — Callog command line

  notify validate [dir]          Check a config repo (default: current directory)
      --github-annotations       Also print GitHub Actions annotations

  notify preview [dir] [--route <id>]...
                                 Markdown preview of routes' examples (all routes by default)

  notify send --route <id> [--data '{"k":"v"}'] [--to github:octocat]...
      --url <url>                Server URL (or NOTIFY_URL)
      --api-key <key>            API key (or NOTIFY_API_KEY)
      --thread-key <key> [--update] [--idempotency-key <key>]
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "validate") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { "github-annotations": { type: "boolean", default: false } },
    });
    const report = validate({
      dir: positionals[0] ?? process.cwd(),
      annotations: values["github-annotations"],
    });
    for (const line of report.lines) console.log(line);
    return report.ok ? 0 : 1;
  }
  if (command === "preview") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { route: { type: "string", multiple: true, default: [] } },
    });
    const result = validateConfigTree(readConfigDir(positionals[0] ?? process.cwd()));
    if (!result.ok) {
      console.error("Config is invalid — run notify validate");
      return 1;
    }
    const ids = values.route.length ? values.route : Object.keys(result.config.routes).sort();
    console.log(previewMarkdown(result.config, ids, result.routeFiles));
    return 0;
  }
  if (command === "send") {
    const { values } = parseArgs({
      args: rest,
      options: {
        url: { type: "string", default: process.env.NOTIFY_URL },
        "api-key": { type: "string", default: process.env.NOTIFY_API_KEY },
        route: { type: "string" },
        data: { type: "string", default: "{}" },
        to: { type: "string", multiple: true, default: [] },
        "thread-key": { type: "string" },
        update: { type: "boolean", default: false },
        "idempotency-key": { type: "string" },
      },
    });
    if (!values.url || !values["api-key"] || !values.route) {
      console.error("send needs --route, --url (or NOTIFY_URL) and --api-key (or NOTIFY_API_KEY)");
      return 2;
    }
    const id = await send({
      url: values.url,
      apiKey: values["api-key"],
      route: values.route,
      data: values.data,
      recipients: values.to,
      threadKey: values["thread-key"],
      update: values.update,
      idempotencyKey: values["idempotency-key"],
    });
    console.log(`Accepted: ${id}`);
    return 0;
  }
  console.log(HELP);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
