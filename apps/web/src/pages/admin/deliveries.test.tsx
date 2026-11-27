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
  group: null,
  notes: [],
  deliveries: [
    {
      ...row.deliveries[0],
      id: "d1",
      attempts: 1,
      lastError: null,
      sentAt: "2026-10-31T10:00:01Z",
      for: [],
      fallbackTo: null,
    },
    {
      ...row.deliveries[1],
      id: "d2",
      attempts: 1,
      lastError: "slack: channel_not_found",
      sentAt: null,
      for: [],
      fallbackTo: null,
    },
  ],
};

const person = (name: string) => ({ ref: `person:${name.toLowerCase()}`, name });

/** Alice's copy was refused and went to the team's room; Bob and a stranger were left out. */
const traced = {
  ...details,
  status: "delivered",
  group: { key: "cpu", joined: true },
  notes: [
    { recipient: person("Bob"), note: "muted" },
    { recipient: { ref: "github:ghost", name: "ghost" }, note: "unknown" },
  ],
  deliveries: [
    {
      id: "d1",
      provider: "slack",
      destination: "dm:UA",
      status: "failed",
      attempts: 1,
      lastError: "slack: cannot_dm_bot",
      sentAt: null,
      for: [person("Alice")],
      fallbackTo: "d2",
    },
    {
      id: "d2",
      provider: "slack",
      destination: "#ops",
      status: "sent",
      attempts: 1,
      lastError: null,
      sentAt: "2026-10-31T10:00:01Z",
      for: [person("Alice")],
      fallbackTo: null,
    },
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

  it("cancels a notification still on its way, after asking, and says who cancelled it", async () => {
    const cancelled: string[] = [];
    const sending = {
      ...details,
      status: "processing",
      cancelled: null,
      deliveries: [details.deliveries[0], { ...details.deliveries[1], status: "pending" }],
    };
    let shown: object = sending;
    server.use(
      http.get("*/api/routes", () =>
        HttpResponse.json({ configRepo: "acme/notify-config", commitSha: null, routes: [] }),
      ),
      http.get("*/api/admin/notifications", () =>
        HttpResponse.json({ items: [{ ...row, status: "processing" }], nextBefore: null }),
      ),
      http.get("*/api/admin/notifications/:id", () => HttpResponse.json(shown)),
      http.post("*/api/admin/notifications/:id/cancel", ({ params }) => {
        cancelled.push(params.id as string);
        shown = {
          ...sending,
          status: "cancelled",
          cancelled: { at: "2026-10-31T10:05:00Z", by: { type: "admin", actor: "@alice" } },
          deliveries: [sending.deliveries[0], { ...sending.deliveries[1], status: "cancelled" }],
        };
        return HttpResponse.json({ status: "cancelled" });
      }),
    );
    renderPage(
      <Routes>
        <Route path="/manage/deliveries/:id?" element={<DeliveriesTab />} />
      </Routes>,
      "/manage/deliveries/n1",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Cancel sending" }));
    expect(screen.getByText("Stop sending this notification?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop sending" }));
    await waitFor(() => expect(cancelled).toEqual(["n1"]));

    expect(await screen.findByText(/Cancelled by @alice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel sending" })).not.toBeInTheDocument();
  });

  it("traces a notification: what took over, whom it was for, who was left out", async () => {
    server.use(
      http.get("*/api/routes", () =>
        HttpResponse.json({ configRepo: "acme/notify-config", commitSha: null, routes: [] }),
      ),
      http.get("*/api/admin/notifications", () =>
        HttpResponse.json({ items: [{ ...row, status: "delivered" }], nextBefore: null }),
      ),
      http.get("*/api/admin/notifications/:id", () => HttpResponse.json(traced)),
    );
    renderPage(
      <Routes>
        <Route path="/manage/deliveries/:id?" element={<DeliveriesTab />} />
      </Routes>,
      "/manage/deliveries/n1",
    );

    expect(await screen.findByText("Bob muted this route")).toBeInTheDocument();
    expect(screen.getByText("github:ghost is nobody Callog knows")).toBeInTheDocument();
    expect(screen.getAllByText("For Alice")).toHaveLength(2);
    expect(screen.getByText(/A repeat: it edited the message of its group/)).toBeInTheDocument();
    // The refused copy was made up for: it is explained, not offered for a retry.
    expect(screen.getByText("slack: cannot_dm_bot")).not.toHaveClass("text-destructive");
    expect(screen.getByText(/^Sent to/)).toHaveTextContent("Sent to #ops instead");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
