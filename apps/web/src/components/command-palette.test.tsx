import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Me } from "@/lib/api";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { CommandPalette, useCommandPalette } from "./command-palette";

const admin = { person: null, githubLogin: "octocat", org: "acme", isAdmin: true } as Me;

describe("CommandPalette", () => {
  it("opens with ⌘K and finds a person by account on the server", async () => {
    server.use(
      http.get("*/api/routes", () =>
        HttpResponse.json({ configRepo: "acme/notify-config", commitSha: null, routes: [] }),
      ),
      http.get("*/api/admin/people", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        const items =
          q === "octo" ? [{ id: "p1", name: "Mona", status: "active", identities: [] }] : [];
        return HttpResponse.json({ items, total: items.length, pageSize: 50 });
      }),
    );
    function Palette() {
      const [open, setOpen] = useCommandPalette();
      return <CommandPalette me={admin} open={open} onOpenChange={setOpen} />;
    }
    const page = renderPage(<Palette />);

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(screen.getByPlaceholderText("Pages, routes, people…"), "octo");
    await userEvent.click(await screen.findByText("Mona"));
    expect(page.location()).toBe("/manage/people/p1");
  });
});
