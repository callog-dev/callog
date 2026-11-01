import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { OverviewTab } from "./overview";

const counters = { routes: 3, people: 10, notifications24h: 5, delivered24h: 4 };

describe("OverviewTab", () => {
  it("links each problem to where it is fixed", async () => {
    server.use(
      http.get("*/api/admin/attention", () =>
        HttpResponse.json({
          items: [
            { kind: "config_rejected", versionId: "v1", errors: 2 },
            { kind: "failed", count: 1 },
          ],
          counters,
        }),
      ),
    );
    renderPage(<OverviewTab />);
    const config = await screen.findByRole("link", {
      name: /config push was rejected \(2 errors\)/,
    });
    expect(config).toHaveAttribute("href", "/manage/config/v1");
    expect(screen.getByRole("link", { name: /1 notification failed/ })).toHaveAttribute(
      "href",
      "/manage/deliveries?status=failed&period=24h",
    );
  });

  it("says when nothing needs attention", async () => {
    server.use(http.get("*/api/admin/attention", () => HttpResponse.json({ items: [], counters })));
    renderPage(<OverviewTab />);
    expect(await screen.findByText(/nothing needs attention/)).toBeInTheDocument();
  });
});
