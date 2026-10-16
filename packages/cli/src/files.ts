import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { ConfigTree } from "@callog/config-schema";

/**
 * YAML files of a config repo checkout (dot-directories and node_modules skipped). A
 * symlink is read the way the server sees it in git — a blob holding the target path —
 * and never followed: a PR could otherwise point a route at any file on the runner.
 */
export function readConfigDir(dir: string): ConfigTree {
  const tree: ConfigTree = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else if (/\.ya?ml$/.test(entry.name)) {
        const file = path.join(dir, relPath);
        tree[relPath] = entry.isSymbolicLink() ? readlinkSync(file) : readFileSync(file, "utf8");
      }
    }
  };
  walk("");
  return tree;
}
