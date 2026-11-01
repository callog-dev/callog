import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RouteSummary, RoutesResponse } from "@/lib/api";
import { server } from "@/test/server";
import { MuteSwitch } from "./route-parts";

const route: RouteSummary = {
  id: "e2e",
  description: null,
  destinations: [],
  dm: true,
  mentions: "recipients",
  allowedSources: { github_repos: [], api_keys: [] },
  dataFields: [],
  muted: false,
  url: "",
};

function renderSwitch(client: QueryClient) {
  client.setQueryData<RoutesResponse>(["routes"], {
    configRepo: "acme/notify-config",
    commitSha: null,
    routes: [route],
  });
  const Switch = () => {
    const current = client.getQueryData<RoutesResponse>(["routes"])!.routes[0]!;
    return <MuteSwitch route={current} linked />;
  };
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Switch />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("MuteSwitch", () => {
  it("mutes at once and rolls back when the server refuses", async () => {
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    server.use(
      http.put("*/api/me/mutes/e2e", async () => {
        await answered;
        return HttpResponse.json({ message: "nope" }, { status: 500 });
      }),
      http.get("*/api/routes", () => new HttpResponse(null, { status: 500 })),
      http.get("*/api/me", () => new HttpResponse(null, { status: 500 })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderSwitch(client);

    await userEvent.click(screen.getByRole("switch", { name: "Personal copies of e2e" }));
    expect(client.getQueryData<RoutesResponse>(["routes"])!.routes[0]!.muted).toBe(true);

    release();
    await waitFor(() =>
      expect(client.getQueryData<RoutesResponse>(["routes"])!.routes[0]!.muted).toBe(false),
    );
  });
});
