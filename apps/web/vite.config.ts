import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// The SPA is served by the Nest server in production (same origin, cookie session).
// In development Vite proxies API and auth routes to the server.
const server = process.env.NOTIFY_SERVER ?? "http://localhost:3010";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/auth": server,
      "/oauth": server,
    },
  },
});
