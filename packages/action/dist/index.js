"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const main_1 = require("./main");
void (0, main_1.main)({
    env: process.env,
    fetch: globalThis.fetch,
    readFile: (path) => (0, node_fs_1.readFileSync)(path, "utf8"),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}).then((code) => {
    process.exitCode = code;
});
//# sourceMappingURL=index.js.map