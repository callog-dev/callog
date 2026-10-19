import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ProviderBadge } from "@/components/provider-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminApi, type NotificationRow, type NotificationStatus } from "@/lib/api";
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

function StatusBadge({ status }: { status: NotificationStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace("_", " ")}</Badge>;
}

const source = (s: NotificationRow["source"]) =>
  s.type === "github_oidc"
    ? s.repository
    : s.type === "api_key"
      ? `key ${s.apiKeyName}`
      : `test by ${s.actor}`;

export function DeliveriesTab() {
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["admin", "notifications", status],
    queryFn: ({ pageParam }) =>
      adminApi.notifications({ status: status === "all" ? undefined : status, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {(["delivered", "partially_failed", "failed", "processing", "accepted"] as const).map(
            (s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      {list.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No notifications.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Deliveries</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                <TableCell className="whitespace-nowrap text-muted-foreground" title={r.createdAt}>
                  {ago(r.createdAt)}
                </TableCell>
                <TableCell className="font-medium">
                  {r.route}
                  {r.threadKey && (
                    <div className="text-xs font-normal text-muted-foreground">
                      thread {r.threadKey}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm">{source(r.source)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {r.deliveries.map((d, i) => (
                      <span
                        key={i}
                        className={d.status === "failed" ? "opacity-60 line-through" : ""}
                      >
                        <ProviderBadge provider={d.provider}>{d.destination}</ProviderBadge>
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          Load older
        </Button>
      )}
      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {open && <Details id={open} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Details({ id }: { id: string }) {
  const n = useQuery({
    queryKey: ["admin", "notification", id],
    queryFn: () => adminApi.notification(id),
  });
  if (!n.data) return <Skeleton className="m-4 h-64" />;
  const d = n.data;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {d.route} <StatusBadge status={d.status} />
        </SheetTitle>
        <SheetDescription>
          {new Date(d.createdAt).toLocaleString()} · {source(d.source)}
          {d.threadKey && ` · thread ${d.threadKey}${d.update ? " (update)" : ""}`}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-6 text-sm">
        <section>
          <h3 className="mb-2 font-medium">Deliveries</h3>
          <div className="space-y-2">
            {d.deliveries.map((x, i) => (
              <div key={i} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <ProviderBadge provider={x.provider}>{x.destination}</ProviderBadge>
                  <span className="text-xs text-muted-foreground">
                    {x.status} · {x.attempts} attempt{x.attempts === 1 ? "" : "s"}
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
