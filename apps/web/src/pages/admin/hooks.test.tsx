import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { HooksTab } from "./hooks";

const hook = {
  id: "h1",
  name: "grafana",
  routeId: "alert",
  prefix: "hk_abcdef",
  routeMissing: false,
  createdAt: "2026-10-01T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
};

const routes = () =>
  http.get("*/api/routes", () =>
    HttpResponse.json({
      configRepo: "acme/notify-config",
      commitSha: null,
      routes: [{ id: "alert", targets: [] }],
    }),
  );

describe("HooksTab", () => {
  it("shows the URL of a new hook once, on the host the page was opened on", async () => {
    const bodies: unknown[] = [];
    server.use(
      routes(),
      http.get("*/api/admin/hooks", () => HttpResponse.json([])),
      http.post("*/api/admin/hooks", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...hook, path: "/v1/hooks/hk_shown_once" });
      }),
    );
    renderPage(<HooksTab />);

    expect(await screen.findByText("No hooks yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New hook" }));
    await userEvent.type(screen.getByLabelText("Name"), "grafana");
    await userEvent.click(screen.getByRole("combobox", { name: "Route" }));
    await userEvent.click(await screen.findByRole("option", { name: "alert" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByLabelText("hook URL")).toHaveValue(
      `${window.location.origin}/v1/hooks/hk_shown_once`,
    );
    expect(bodies).toEqual([{ name: "grafana", route: "alert" }]);
  });

  it("flags a hook whose route left the config, and revokes only after confirmation", async () => {
    const revoked: string[] = [];
    server.use(
      routes(),
      http.get("*/api/admin/hooks", () => HttpResponse.json([{ ...hook, routeMissing: true }])),
      http.delete("*/api/admin/hooks/:name", ({ params }) => {
        revoked.push(params.name as string);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage(<HooksTab />);

    expect(await screen.findByText("alert — not in the config")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revoked).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoked).toEqual(["grafana"]));
  });
});
