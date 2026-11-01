import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import { DataTable, useUrlTableView, type ColumnDef } from "./data-table";

interface Person {
  name: string;
  team: string;
}

const people: Person[] = [
  { name: "Alice", team: "frontend" },
  { name: "Bob", team: "backend" },
  { name: "Carol", team: "frontend" },
];

const columns: ColumnDef<Person>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "team", header: "Team", enableSorting: false },
];

function Synced({ pageSize }: { pageSize?: number }) {
  return (
    <DataTable
      columns={columns}
      data={people}
      empty="Nobody"
      search="Search people"
      view={useUrlTableView()}
      pageSize={pageSize}
    />
  );
}

const table = (props: { pageSize?: number } = {}) => <Synced {...props} />;

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]!.textContent);

describe("DataTable", () => {
  it("keeps the search in the URL and restores it on reload", async () => {
    const page = renderPage(table(), "/people");
    await userEvent.type(screen.getByLabelText("Search people"), "front");
    await waitFor(() => expect(names()).toEqual(["Alice", "Carol"]));
    expect(page.location()).toBe("/people?q=front");

    page.unmount();
    renderPage(table(), "/people?q=front");
    expect(screen.getByLabelText("Search people")).toHaveValue("front");
    expect(names()).toEqual(["Alice", "Carol"]);
  });

  it("sorts by a column and pages through the rows", async () => {
    const page = renderPage(table({ pageSize: 2 }), "/people");
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Carol", "Bob"]);
    expect(page.location()).toBe("/people?sort=-name");

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(names()).toEqual(["Alice"]);
    expect(page.location()).toBe("/people?sort=-name&page=2");
  });

  it("shows the empty state when there are no rows", () => {
    renderPage(<DataTable columns={columns} data={[]} empty="Nobody yet" />);
    expect(screen.getByText("Nobody yet")).toBeInTheDocument();
  });
});
