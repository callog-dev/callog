import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { PlacesTab } from "./places";

describe("PlacesTab", () => {
  it("lists each place with its room and the routes that use it", async () => {
    server.use(
      http.get("*/api/admin/places", () =>
        HttpResponse.json([
          {
            name: "deploys",
            channel: "slack",
            room: "#deploys",
            routes: ["release"],
            defaultFor: [],
          },
          { name: "lost", channel: "telegram", room: "-1001", routes: [], defaultFor: ["alert"] },
          { name: "spare", channel: "slack", room: "#spare", routes: [], defaultFor: [] },
        ]),
      ),
    );
    renderPage(<PlacesTab />);

    expect(await screen.findByText("#deploys")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "release" })).toHaveAttribute(
      "href",
      "/routes/release",
    );
    expect(screen.getByText("(by default)")).toBeInTheDocument();
    expect(screen.getByText("no route — senders can still name it")).toBeInTheDocument();
  });

  it("says where places come from when there are none", async () => {
    server.use(http.get("*/api/admin/places", () => HttpResponse.json([])));
    renderPage(<PlacesTab />);
    expect(await screen.findByText("No places yet")).toBeInTheDocument();
  });
});
