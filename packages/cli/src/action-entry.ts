import { runAction } from "./action";

void runAction({
  env: process.env,
  fetch: globalThis.fetch,
  log: (line) => console.log(line),
}).then((code) => {
  process.exitCode = code;
});
