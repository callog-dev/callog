import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ConfigTree } from "./parse";

/** Reads a fixture directory into a ConfigTree (repo-relative POSIX paths). */
export function loadFixture(name: string): ConfigTree {
  const root = path.resolve(__dirname, "../fixtures", name);
  const tree: ConfigTree = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    tree[path.relative(root, abs).split(path.sep).join("/")] = readFileSync(abs, "utf8");
  }
  return tree;
}
