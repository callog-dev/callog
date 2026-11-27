import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { TestNotificationDialog } from "./test-notification";

function setup(targets: object[]) {
  const sent: string[] = [];
  server.use(
    http.get("*/api/routes", () =>
      HttpResponse.json({ configRepo: "acme/notify-config", commitSha: null, routes: [] }),
    ),
    http.get("*/api/admin/routes/hello/test", () =>
      HttpResponse.json({ configVersion: "v1", targets }),
    ),
    http.post("*/api/admin/routes/hello/test", async ({ request }) => {
      sent.push(((await request.json()) as { configVersion: string }).configVersion);
      return HttpResponse.json({ notificationId: "n1" }, { status: 201 });
    }),
    http.get("*/api/admin/notifications/n1", () =>
      HttpResponse.json({ id: "n1", route: "hello", status: "processing", deliveries: [] }),
    ),
  );
  renderPage(<TestNotificationDialog route="hello" onClose={() => {}} />);
  return sent;
}

const send = () => screen.findByRole("button", { name: "Send test" });

describe("TestNotificationDialog", () => {
  it("names where the test is posted and sends only after confirmation", async () => {
    const sent = setup([
      { provider: "slack", kind: "place", destination: "#general", for: [], fallbacks: [] },
      {
        provider: "telegram",
        kind: "place",
        destination: "-1001",
        label: "Deploys",
        for: [],
        fallbacks: [],
      },
      {
        provider: "slack",
        kind: "person",
        destination: "UOLGA",
        for: [{ ref: "person:1", name: "Olga" }],
        fallbacks: [{ provider: "slack", kind: "place", destination: "#lost" }],
      },
    ]);
    await waitFor(async () => expect(await send()).toBeEnabled());
    await userEvent.click(await send());

    const confirm = screen.getByRole("alertdialog");
    expect(within(confirm).getByText("#general")).toBeInTheDocument();
    expect(within(confirm).getByText("Deploys")).toBeInTheDocument();
    expect(within(confirm).getByText("a personal copy for Olga")).toBeInTheDocument();
    expect(within(confirm).getByText("#lost")).toBeInTheDocument();
    expect(sent).toEqual([]);

    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);

    await userEvent.click(await send());
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Send" }),
    );
    await waitFor(() => expect(sent).toEqual(["v1"]));
  });

  it("warns when the route has nowhere to post", async () => {
    setup([]);
    await waitFor(async () => expect(await send()).toBeEnabled());
    await userEvent.click(await send());
    expect(
      within(screen.getByRole("alertdialog")).getByText(/has nowhere to post/),
    ).toBeInTheDocument();
  });
});
