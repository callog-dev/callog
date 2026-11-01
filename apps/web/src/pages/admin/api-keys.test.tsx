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

  it("explains what keys are for when there are none", async () => {
    server.use(http.get("*/api/admin/api-keys", () => HttpResponse.json([])));
    renderPage(<ApiKeysTab />);
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
  });
});
