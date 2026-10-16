// Forwards GitHub webhooks from a smee.io channel to the local server (development only).
import { existsSync } from "node:fs";
import { SmeeClient } from "smee-client";

if (existsSync(".env")) process.loadEnvFile(".env");

const source = process.env.SMEE_URL;
if (!source) {
  console.error("SMEE_URL is not set. Create a channel at https://smee.io/new and add it to .env");
  process.exit(1);
}
const target = `http://localhost:${process.env.PORT ?? 3000}/webhooks/github`;

const client = new SmeeClient({ source, target, logger: console });
await client.start();
