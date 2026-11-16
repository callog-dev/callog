import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { ApiKeysTab } from "./api-keys";

const key = {
  id: "k1",
  name: "billing",
  prefix: "ntf_abcd",
  direct: false,
  createdAt: "2026-10-01T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
};

describe("ApiKeysTab", () => {
  it("revokes a key only after confirmation", async () => {
    const revoked: string[] = [];
    server.use(
      http.get("*/api/admin/api-keys", () => HttpResponse.json([key])),
      http.delete("*/api/admin/api-keys/:name", ({ params }) => {
        revoked.push(params.name as string);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage(<ApiKeysTab />);

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(revoked).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoked).toEqual(["billing"]));
  });

  it("creates a key that may send direct messages", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get("*/api/admin/api-keys", () => HttpResponse.json([{ ...key, direct: true }])),
      http.post("*/api/admin/api-keys", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...key, name: "ops", direct: true, key: "ntf_shown_once" });
      }),
    );
    renderPage(<ApiKeysTab />);

    expect(await screen.findByText("direct")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New key" }));
    await userEvent.type(screen.getByLabelText("Name"), "ops");
    await userEvent.click(screen.getByLabelText("Direct messages"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByDisplayValue("ntf_shown_once")).toBeInTheDocument();
    expect(bodies).toEqual([{ name: "ops", direct: true }]);
  });

  it("explains what keys are for when there are none", async () => {
    server.use(http.get("*/api/admin/api-keys", () => HttpResponse.json([])));
    renderPage(<ApiKeysTab />);
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
  });
});
