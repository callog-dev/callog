import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { RoutePage } from "./route";

const summary = {
  id: "e2e",
  description: "e2e failures",
  destinations: [{ provider: "slack", destination: "#alerts" }],
  dm: false,
  mentions: "recipients",
  allowedSources: { github_repos: ["acme/e2e"], api_keys: [] },
  dataFields: ["branch"],
  muted: false,
  url: "https://github.com/acme/notify-config/blob/abc/routes/e2e.yaml",
};

const page = (admin: boolean) =>
  renderPage(
    <Routes>
      <Route path="/routes/:routeId" element={<RoutePage linked admin={admin} />} />
    </Routes>,
    "/routes/e2e",
  );

describe("RoutePage", () => {
  it("shows admins the template and a test button", async () => {
    server.use(
      http.get("*/api/routes/e2e", () =>
        HttpResponse.json({ ...summary, template: [{ text: "hi" }], examples: [], schema: null }),
      ),
    );
    page(true);
    expect(await screen.findByText("Template and examples")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test" })).toBeInTheDocument();
  });

  it("shows engineers the route without them", async () => {
    server.use(http.get("*/api/routes/e2e", () => HttpResponse.json(summary)));
    page(false);
    expect(await screen.findByText("e2e failures")).toBeInTheDocument();
    expect(screen.queryByText("Template and examples")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send test" })).not.toBeInTheDocument();
  });
});
