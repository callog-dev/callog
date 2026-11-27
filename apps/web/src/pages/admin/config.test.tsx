import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { ConfigPage } from "./config";

const place = (name: string, room: string, issue?: object) => ({
  name,
  channel: "slack",
  room,
  routes: [],
  defaultFor: [],
  issue,
});

describe("ConfigPage", () => {
  beforeEach(() => {
    server.use(
      http.get("*/api/admin/status", () =>
        HttpResponse.json({
          configRepo: "acme/notify-config",
          config: { active: { commitSha: "abcdef0123", routes: 2 }, latest: null },
        }),
      ),
      http.get("*/api/admin/config/versions", () =>
        HttpResponse.json({ items: [], nextBefore: null }),
      ),
    );
  });

  it("names the places whose Slack channel has a problem", async () => {
    server.use(
      http.get("*/api/admin/places", () =>
        HttpResponse.json([
          place("feed", "#alerts"),
          place("gone", "#nope", {
            level: "error",
            message: "Slack channel #nope was not found.",
          }),
          place("slow", "#later", {
            level: "warning",
            message: "Slack channel #later is not checked yet.",
          }),
        ]),
      ),
    );
    renderPage(<ConfigPage />);

    const problems = within(await screen.findByRole("list", { name: "Places with problems" }));
    expect(problems.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "gone — Slack channel #nope was not found.",
      "slow — Slack channel #later is not checked yet.",
    ]);
    expect(screen.queryByText("feed")).not.toBeInTheDocument();
  });

  it("says nothing about places when all of them are fine", async () => {
    server.use(http.get("*/api/admin/places", () => HttpResponse.json([place("feed", "#alerts")])));
    renderPage(<ConfigPage />);

    expect(await screen.findByText("2 routes from abcdef0")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Places with problems" })).not.toBeInTheDocument();
  });
});
