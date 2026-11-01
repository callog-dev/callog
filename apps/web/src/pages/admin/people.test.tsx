import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { server } from "@/test/server";
import { PeoplePage } from "./people";

const person = (i: number) => ({
  id: `p${i}`,
  name: `Person ${i}`,
  status: "active",
  identities: [],
});

describe("PeoplePage", () => {
  it("searches and pages on the server, keeping both in the URL", async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get("*/api/admin/unmapped", () => HttpResponse.json([])),
      http.get("*/api/admin/identities/suggested", () => HttpResponse.json([])),
      http.get("*/api/admin/people", ({ request }) => {
        const params = new URL(request.url).searchParams;
        asked.push(params);
        const items = params.get("q") ? [person(7)] : [person(1), person(2)];
        return HttpResponse.json({ items, total: params.get("q") ? 1 : 120, pageSize: 50 });
      }),
    );
    const page = renderPage(
      <Routes>
        <Route path="/manage/people/*" element={<PeoplePage />} />
      </Routes>,
      "/manage/people",
    );

    expect(await screen.findByText("Person 1")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(asked.at(-1)?.get("page")).toBe("2"));
    expect(page.location()).toBe("/manage/people?page=2");

    await userEvent.type(screen.getByLabelText("Search by name or account"), "seven");
    expect(await screen.findByText("Person 7")).toBeInTheDocument();
    expect(asked.at(-1)?.get("q")).toBe("seven");
    expect(asked.at(-1)?.get("page")).toBe("1");
  });
});
