export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A server-rendered page outside the SPA; `body` is trusted HTML. */
export function htmlDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Callog</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}a{color:inherit}
label{display:block;margin:1rem 0 .25rem}input{font:inherit;width:100%;box-sizing:border-box}
button{display:block;font:inherit;margin-top:1rem}pre{white-space:pre-wrap;word-break:break-all;font-size:13px}
small{display:block;margin-top:.25rem;opacity:.7}</style></head><body>${body}</body></html>`;
}
