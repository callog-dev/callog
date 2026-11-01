import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { DeliveriesTab } from "./deliveries";

const row = {
  id: "n1",
  route: "e2e-failed",
  status: "partially_failed",
  source: { type: "github_oidc", repository: "acme/e2e" },
  threadKey: null,
  createdAt: "2026-10-31T10:00:00Z",
  deliveries: [
    { provider: "slack", destination: "#alerts", status: "sent" },
    { provider: "slack", destination: "#gone", status: "failed" },
  ],
};

const details = {
  ...row,
  data: { branch: "main" },
  recipients: [],
  update: false,
  deliveries: [
    { ...row.deliveries[0], attempts: 1, lastError: null, sentAt: "2026-10-31T10:00:01Z" },
    { ...row.deliveries[1], attempts: 1, lastError: "slack: channel_not_found", sentAt: null },
  ],
};

describe("DeliveriesTab", () => {
  it("opens a notification from its URL, filtered as linked, and retries what failed", async () => {
    const listed: URLSearchParams[] = [];
    const retried: string[] = [];
    server.use(
      http.get("*/api/routes", () =>
        HttpResponse.json({ configRepo: "acme/notify-config", commitSha: null, routes: [] }),
      ),
      http.get("*/api/admin/notifications", ({ request }) => {
        listed.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: [row], nextBefore: null });
      }),
      http.get("*/api/admin/notifications/:id", () => HttpResponse.json(details)),
      http.post("*/api/admin/notifications/:id/retry", ({ params }) => {
        retried.push(params.id as string);
        return HttpResponse.json({ status: "accepted" }, { status: 202 });
      }),
    );
    renderPage(
      <Routes>
        <Route path="/manage/deliveries/:id?" element={<DeliveriesTab />} />
      </Routes>,
      "/manage/deliveries/n1?status=partially_failed",
    );

    expect(await screen.findByText("slack: channel_not_found")).toBeInTheDocument();
    expect(listed[0]?.get("status")).toBe("partially_failed");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Send 1 failed delivery again?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retried).toEqual(["n1"]));
  });
});
