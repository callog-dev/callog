"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.input = input;
exports.booleanInput = booleanInput;
exports.setOutput = setOutput;
exports.annotation = annotation;
const node_fs_1 = require("node:fs");
function input(env, name) {
    return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function booleanInput(env, name) {
    const value = input(env, name).toLowerCase();
    if (value === "" || value === "false")
        return false;
    if (value === "true")
        return true;
    throw new Error(`Input "${name}" must be true or false, got "${value}"`);
}
function setOutput(env, name, value) {
    if (env.GITHUB_OUTPUT)
        (0, node_fs_1.appendFileSync)(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
/** Escapes a message for a workflow command (`::warning::…`). */
function annotation(kind, message) {
    return `::${kind}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}
//# sourceMappingURL=runtime.js.map