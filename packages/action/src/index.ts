import { readFileSync } from "node:fs";
import { main } from "./main";

void main({
  env: process.env,
  fetch: globalThis.fetch,
  readFile: (path) => readFileSync(path, "utf8"),
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}).then((code) => {
  process.exitCode = code;
});
