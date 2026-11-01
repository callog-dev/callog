import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Send, X } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { DataTable, type ColumnDef } from "@/components/data-table";
import { FilterSelect } from "@/components/filter-select";
import { ProviderBadge } from "@/components/provider-badge";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlState } from "@/hooks/use-url-state";
import { adminApi, api, type NotificationRow, type NotificationStatus } from "@/lib/api";
import { ago } from "@/lib/time";

const STATUS_VARIANT: Record<
  NotificationStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  delivered: "secondary",
  accepted: "outline",
  processing: "outline",
  partially_failed: "destructive",
  failed: "destructive",
};

const POLL_MS = 10_000;

const STATUSES = ["delivered", "partially_failed", "failed", "processing", "accepted"] as const;

const PERIODS = [
  ["all", "Any time"],
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
] as const;

function StatusBadge({ status }: { status: NotificationStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace("_", " ")}</Badge>;
}

/** `key` is what the source filter matches: a repository or an API key name. */
function describeSource(s: NotificationRow["source"]): { key: string | null; label: string } {
  if (s.type === "github_oidc") return { key: s.repository, label: s.repository };
  if (s.type === "api_key") return { key: s.apiKeyName, label: `key ${s.apiKeyName}` };
  return { key: null, label: `test by ${s.actor}` };
}

const FILTERS = { status: "all", route: "all", source: "", period: "all" };

export function DeliveriesTab() {
  const client = useQueryClient();
  const [filters, setFilters] = useUrlState(FILTERS);
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The filters stay in the query string while a notification is open.
  const show = (path: string) => navigate({ pathname: path, search: `${params}` });

  const query = {
    status: filters.status === "all" ? undefined : filters.status,
    route: filters.route === "all" ? undefined : filters.route,
    source: filters.source || undefined,
    period: filters.period === "all" ? undefined : filters.period,
  };
  const list = useInfiniteQuery({
    queryKey: ["admin", "notifications", query],
    queryFn: ({ pageParam }) => adminApi.notifications({ ...query, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Counts what arrived above the top row; the loaded pages and the scroll position stay.
  const top = rows[0]?.id;
  const newer = useQuery({
    queryKey: ["admin", "notifications-newer", query, top],
    queryFn: () => adminApi.notificationCount({ ...query, after: top! }),
    refetchInterval: POLL_MS,
    enabled: top !== undefined,
  });
  const newCount = newer.data?.count ?? 0;
  const columns = useMemo(() => deliveryColumns((source) => setFilters({ source })), [setFilters]);
  const filtered = Object.entries(filters).some(
    ([key, value]) => value !== FILTERS[key as keyof typeof FILTERS],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(status) => setFilters({ status })}
          options={[
            ["all", "All statuses"],
            ...STATUSES.map((s) => [s, s.replace("_", " ")] as const),
          ]}
        />
        <FilterSelect
          label="Route"
          value={filters.route}
          onChange={(route) => setFilters({ route })}
          options={[
            ["all", "All routes"],
            ...(routes.data?.routes ?? []).map((r) => [r.id, r.id] as const),
          ]}
        />
        <FilterSelect
          label="Period"
          value={filters.period}
          onChange={(period) => setFilters({ period })}
          options={[...PERIODS]}
        />
        {filters.source && (
          <Badge variant="secondary" className="gap-1">
            from {filters.source}
            <button aria-label="Clear the source filter" onClick={() => setFilters({ source: "" })}>
              <X className="size-3" />
            </button>
          </Badge>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(FILTERS)}>
            Reset
          </Button>
        )}
      </div>

      {newCount > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => {
            // Back to the first page, refetched in place (no loading state, no older pages).
            const key = ["admin", "notifications", query];
            client.setQueryData<typeof list.data>(
              key,
              (data) => data && { pages: data.pages.slice(0, 1), pageParams: [undefined] },
            );
            void client.invalidateQueries({ queryKey: key, exact: true });
          }}
        >
          {newCount === 1 ? "1 new notification" : `${newCount} new notifications`}: show
        </Button>
      )}
      {list.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          onRowClick={(r) => show(`/manage/deliveries/${r.id}`)}
          manual={{
            footer: list.hasNextPage && (
              <Button
                variant="outline"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                Load older
              </Button>
            ),
          }}
          empty={
            <EmptyState icon={Send} title={filtered ? "Nothing matches" : "No notifications yet"}>
              {filtered
                ? "No notification matches these filters."
                : "Notifications show up here once a workflow or service sends one."}
            </EmptyState>
          }
        />
      )}

      <Sheet open={id !== undefined} onOpenChange={(o) => !o && show("/manage/deliveries")}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {id && <Details id={id} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function deliveryColumns(filterSource: (source: string) => void): ColumnDef<NotificationRow>[] {
  return [
    {
      accessorKey: "createdAt",
      header: "When",
      meta: { className: "whitespace-nowrap text-muted-foreground" },
      cell: ({ row }) => <span title={row.original.createdAt}>{ago(row.original.createdAt)}</span>,
    },
    {
      accessorKey: "route",
      header: "Route",
      meta: { className: "font-medium" },
      cell: ({ row: { original: r } }) => (
        <>
          {r.route}
          {r.threadKey && (
            <div className="text-xs font-normal text-muted-foreground">thread {r.threadKey}</div>
          )}
        </>
      ),
    },
    {
      id: "source",
      header: "From",
      meta: { className: "text-sm" },
      cell: ({ row: { original: r } }) => {
        const { key, label } = describeSource(r.source);
        return key ? (
          <button
            className="underline-offset-4 hover:underline"
            title="Show only notifications from here"
            onClick={(e) => {
              e.stopPropagation();
              filterSource(key);
            }}
          >
            {label}
          </button>
        ) : (
          label
        );
      },
    },
    {
      id: "deliveries",
      header: "Deliveries",
      cell: ({ row: { original: r } }) => (
        <div className="flex flex-wrap gap-1">
          {r.deliveries.map((d, i) => (
            <span key={i} className={d.status === "failed" ? "line-through opacity-60" : ""}>
              <ProviderBadge provider={d.provider}>{d.destination}</ProviderBadge>
            </span>
          ))}
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
  ];
}

function Details({ id }: { id: string }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const n = useQuery({
    queryKey: ["admin", "notification", id],
    queryFn: () => adminApi.notification(id),
  });
  const retry = useMutation({
    mutationFn: () => adminApi.retryNotification(id),
    onSuccess: () => {
      toast.success("Sending the failed deliveries again");
      void client.invalidateQueries({ queryKey: ["admin", "notification", id] });
      // The list catches up when it is next shown, instead of refetching every loaded page now.
      void client.invalidateQueries({ queryKey: ["admin", "notifications"], refetchType: "none" });
    },
    onError: (e) => toast.error(e.message),
  });
  if (n.isError) return <ErrorState error={n.error} retry={() => void n.refetch()} />;
  if (!n.data) return <Skeleton className="m-4 h-64" />;
  const d = n.data;
  const failed = d.deliveries.filter((x) => x.status === "failed").length;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {d.route} <StatusBadge status={d.status} />
        </SheetTitle>
        <SheetDescription>
          {new Date(d.createdAt).toLocaleString()} · {describeSource(d.source).label}
          {d.threadKey && ` · thread ${d.threadKey}${d.update ? " (update)" : ""}`}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-6 text-sm">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Deliveries</h3>
            {failed > 0 && d.status !== "processing" && d.status !== "accepted" && (
              <Button
                size="sm"
                variant="outline"
                disabled={retry.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Send ${failed} failed ${failed === 1 ? "delivery" : "deliveries"} again?`,
                    description: d.threadKey
                      ? "They go to the same thread; messages already sent are not repeated."
                      : "Messages already sent are not repeated.",
                    action: "Retry",
                  });
                  if (ok) retry.mutate();
                }}
              >
                <RotateCw /> Retry
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {d.deliveries.map((x, i) => (
              <div key={i} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <ProviderBadge provider={x.provider}>{x.destination}</ProviderBadge>
                  <span className="text-xs text-muted-foreground">
                    {x.status} · {x.attempts} attempt{x.attempts === 1 ? "" : "s"}
                    {x.sentAt && ` · ${ago(x.sentAt)}`}
                  </span>
                </div>
                {x.lastError && <p className="mt-1 text-destructive">{x.lastError}</p>}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-2 font-medium">Recipients</h3>
          <div className="flex flex-wrap gap-1">
            {d.recipients.length ? (
              d.recipients.map((r) => (
                <code key={r} className="rounded bg-muted px-1">
                  {r}
                </code>
              ))
            ) : (
              <span className="text-muted-foreground">none</span>
            )}
          </div>
        </section>
        <section>
          <h3 className="mb-2 font-medium">Data</h3>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(d.data, null, 2)}
          </pre>
        </section>
      </div>
    </>
  );
}
