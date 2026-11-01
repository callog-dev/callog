import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Table as TanStackTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";

export type { ColumnDef } from "@tanstack/react-table";

/** Search, sorting (`name` or `-name`) and 1-based page, as strings so they fit a URL. */
export type TableView = { q: string; sort: string; page: string };
type ViewState = readonly [TableView, (patch: Partial<TableView>) => void];

const FIRST: TableView = { q: "", sort: "", page: "1" };

/** Keeps a table's view in the query string; one such table per page. */
export function useUrlTableView(): ViewState {
  return useUrlState(FIRST);
}

export interface DataTableProps<T> {
  // TanStack's own data-table pattern: each column has its own value type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  data: T[];
  /** Shown instead of the table when there is nothing at all (not merely no search match). */
  empty: ReactNode;
  /** Adds a search box; client-side it matches every column's value. */
  search?: string;
  pageSize?: number;
  /** From `useUrlTableView()`; without it the view lives in component state. */
  view?: ViewState;
  /**
   * The caller filters, sorts and pages on the server from `view`: `data` is one page as is,
   * and `footer` holds the paging controls.
   */
  manual?: { footer?: ReactNode };
  getRowId?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  /** Makes rows clickable (and reachable with the keyboard). */
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  empty,
  search,
  pageSize = 50,
  view: external,
  manual,
  getRowId,
  rowClassName,
  onRowClick,
  toolbar,
}: DataTableProps<T>) {
  const [local, setLocal] = useState(FIRST);
  const [view, setView] = external ?? [
    local,
    (patch: Partial<TableView>) => setLocal((v) => ({ ...v, ...patch })),
  ];
  const sorting = parseSort(view.sort);
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      globalFilter: view.q,
      sorting,
      pagination: { pageIndex: Math.max(0, Number(view.page) - 1 || 0), pageSize },
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setView({ sort: formatSort(next), page: FIRST.page });
    },
    onPaginationChange: (updater) => {
      const current = table.getState().pagination;
      const next = typeof updater === "function" ? updater(current) : updater;
      setView({ page: String(next.pageIndex + 1) });
    },
    manualFiltering: !!manual,
    manualSorting: !!manual,
    manualPagination: !!manual,
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: manual ? undefined : getFilteredRowModel(),
    getSortedRowModel: manual ? undefined : getSortedRowModel(),
    getPaginationRowModel: manual ? undefined : getPaginationRowModel(),
  });

  if (data.length === 0 && !view.q) return <>{empty}</>;
  const rows = table.getRowModel().rows;

  return (
    <div className="space-y-3">
      {(search !== undefined || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {search !== undefined && (
            <SearchBox
              label={search}
              value={view.q}
              onChange={(q) => setView({ q, page: FIRST.page })}
            />
          )}
          {toolbar}
        </div>
      )}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const label = flexRender(header.column.columnDef.header, header.getContext());
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {label}
                        {sorted === "asc" && <ArrowUp className="size-3" />}
                        {sorted === "desc" && <ArrowDown className="size-3" />}
                      </button>
                    ) : (
                      label
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow
                key={row.id}
                className={cn(onRowClick && "cursor-pointer", rowClassName?.(row.original))}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick && (() => onRowClick(row.original))}
                onKeyDown={onRowClick && ((e) => e.key === "Enter" && onRowClick(row.original))}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                Nothing matches “{view.q}”.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {manual ? manual.footer : table.getPageCount() > 1 && <Pager table={table} />}
    </div>
  );
}

/** A trailing column of row buttons. */
export function actionsColumn<T>(cell: (row: T) => ReactNode): ColumnDef<T> {
  return {
    id: "actions",
    meta: { className: "text-right" },
    cell: ({ row }) => cell(row.original),
  };
}

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    className?: string;
  }
}

/** Typing stays local; the view (and with it the URL) follows once typing pauses. */
function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  const commit = useRef(onChange);
  commit.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => commit.current(text), 200);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <div className="relative w-full max-w-xs">
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={text}
        placeholder={label}
        aria-label={label}
        className="pl-8"
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

function Pager<T>({ table }: { table: TanStackTable<T> }) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
      Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Previous page"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Next page"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

function parseSort(sort: string): SortingState {
  if (!sort) return [];
  return [{ id: sort.replace(/^-/, ""), desc: sort.startsWith("-") }];
}

function formatSort(sorting: SortingState): string {
  const [first] = sorting;
  return first ? `${first.desc ? "-" : ""}${first.id}` : "";
}
