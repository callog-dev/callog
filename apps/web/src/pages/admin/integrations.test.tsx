import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { IntegrationsPage } from "./integrations";

const status = (overrides: object = {}) => ({
  tenantId: "t1",
  installationId: 1,
  org: "acme",
  configRepo: "acme/notify-config",
  config: { active: null, latest: null },
  slack: { team: "Acme", commands: true, lastSyncedAt: null },
  telegram: null,
  ...overrides,
});

describe("IntegrationsPage", () => {
  it("disconnects Slack only after confirmation", async () => {
    let disconnected = 0;
    server.use(
      http.get("*/api/admin/status", () => HttpResponse.json(status())),
      http.delete("*/api/admin/slack", () => {
        disconnected += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage(<IntegrationsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect Acme?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(disconnected).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnected).toBe(1));
  });

  it("offers to connect what is not connected", async () => {
    server.use(http.get("*/api/admin/status", () => HttpResponse.json(status({ slack: null }))));
    renderPage(<IntegrationsPage />);
    expect(await screen.findByRole("button", { name: "Connect Slack" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
  });
});
