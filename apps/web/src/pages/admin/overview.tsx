import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, CircleCheck, Info } from "lucide-react";
import { Link } from "react-router";
import { ErrorState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, type AttentionItem } from "@/lib/api";
import { ago } from "@/lib/time";

/** What needs attention, each item linking to where it is fixed, then a few counters. */
export function OverviewTab() {
  // Fresh on every visit: an item should be gone right after it was fixed elsewhere.
  const attention = useQuery({
    queryKey: ["admin", "attention"],
    queryFn: adminApi.attention,
    staleTime: 0,
  });
  if (attention.isPending) return <Skeleton className="h-48 w-full" />;
  if (attention.isError) {
    return <ErrorState error={attention.error} retry={() => void attention.refetch()} />;
  }
  const { items, counters } = attention.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Needs attention</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length ? (
            <ul className="divide-y rounded-md border">
              {items.map((item) => {
                const { text, to, severity } = describe(item);
                return (
                  <li key={item.kind}>
                    <Link
                      to={to}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50"
                    >
                      {severity === "error" ? (
                        <CircleAlert className="size-4 shrink-0 text-destructive" />
                      ) : (
                        <Info className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex-1">{text}</span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> All good:
              nothing needs attention.
            </p>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Routes" value={counters.routes} to="/routes" />
        <Counter label="People" value={counters.people} to="/manage/people" />
        <Counter
          label="Notifications, 24 h"
          value={counters.notifications24h}
          to="/manage/deliveries?period=24h"
        />
        <Counter
          label="Delivered, 24 h"
          value={counters.delivered24h}
          to="/manage/deliveries?period=24h&status=delivered"
        />
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describe(item: AttentionItem): { text: string; to: string; severity: "error" | "info" } {
  switch (item.kind) {
    case "config_rejected":
      return {
        text: `The latest config push was rejected (${plural(item.errors, "error")}); the previous version stays active.`,
        to: `/manage/config/${item.versionId}`,
        severity: "error",
      };
    case "no_config":
      return { text: "No valid config is loaded yet.", to: "/manage/config", severity: "error" };
    case "slack_missing":
      return { text: "Slack is not connected.", to: "/manage/integrations", severity: "error" };
    case "failed":
      return {
        text: `${plural(item.count, "notification")} failed in the last 24 hours.`,
        to: "/manage/deliveries?status=failed&period=24h",
        severity: "error",
      };
    case "partially_failed":
      return {
        text: `${plural(item.count, "notification")} partially failed in the last 24 hours.`,
        to: "/manage/deliveries?status=partially_failed&period=24h",
        severity: "error",
      };
    case "unmapped":
      return {
        text: `${plural(item.count, "recipient")} mentioned as plain text: nobody is linked to them.`,
        to: "/manage/people/unmapped",
        severity: "info",
      };
    case "suggested":
      return {
        text: `${plural(item.count, "suggested link")} to confirm.`,
        to: "/manage/people/suggested",
        severity: "info",
      };
    case "sync_stale":
      return {
        text: item.lastSyncedAt
          ? `People were last synced from Slack ${ago(item.lastSyncedAt)}.`
          : "People have not been synced from Slack yet.",
        to: "/manage/integrations",
        severity: "info",
      };
  }
}

function Counter({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:bg-muted/50">
        <CardHeader>
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        </CardHeader>
      </Card>
    </Link>
  );
}
