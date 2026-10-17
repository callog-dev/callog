export const SETUP_PATH = "/setup/github-app";
export const SETUP_CALLBACK_PATH = `${SETUP_PATH}/callback`;

/** GitHub's limit on App names; the operator can still rename the App on GitHub's form. */
const MAX_APP_NAME = 34;

/**
 * GitHub delivers webhooks from the internet, so a server on localhost needs a relay
 * (smee.io) in front of it; browser redirects to localhost work as they are.
 */
export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
}

/** App names are unique across GitHub, so the org goes into the default. */
export function defaultAppName(org: string): string {
  return `Callog ${org}`.slice(0, MAX_APP_NAME);
}

/**
 * The App registration GitHub's manifest flow creates: the same URLs, permissions and events
 * a manual registration needs (README → GitHub App).
 */
export function buildManifest(options: { publicUrl: string; webhookUrl: string; name: string }) {
  const base = options.publicUrl.replace(/\/+$/, "");
  return {
    name: options.name,
    url: base,
    hook_attributes: { url: options.webhookUrl, active: true },
    redirect_url: `${base}${SETUP_CALLBACK_PATH}`,
    callback_urls: [`${base}/oauth/github/callback`],
    public: false,
    default_permissions: { contents: "read", metadata: "read", members: "read" },
    default_events: ["push", "organization"],
  };
}

/** Credentials GitHub returns once for a created App (`POST /app-manifests/{code}/conversions`). */
export interface CreatedGithubApp {
  id: number;
  slug: string;
  html_url: string;
  owner: { login: string } | null;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

/**
 * `.env` lines for the created App. The key goes in as one line with `\n` escapes: both
 * docker compose and the server's own .env loader expand them in double quotes.
 */
export function envBlock(app: CreatedGithubApp): string {
  const pem = app.pem.trim().replace(/\r?\n/g, "\\n");
  return [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_PRIVATE_KEY="${pem}\\n"`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
    `GITHUB_APP_CLIENT_ID=${app.client_id}`,
    `GITHUB_APP_CLIENT_SECRET=${app.client_secret}`,
  ].join("\n");
}
