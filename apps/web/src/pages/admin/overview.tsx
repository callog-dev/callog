import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw, Send, Hash, Users } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi } from "@/lib/api";
import { ago } from "@/lib/time";

export function OverviewTab() {
  const status = useQuery({ queryKey: ["admin", "status"], queryFn: adminApi.status });
  const teams = useQuery({ queryKey: ["admin", "teams"], queryFn: adminApi.teams });
  const client = useQueryClient();
  const reload = useMutation({
    mutationFn: adminApi.reloadConfig,
    onSuccess: (r) => {
      toast.success(`Config ${r.status}`);
      void client.invalidateQueries({ queryKey: ["admin", "status"] });
      void client.invalidateQueries({ queryKey: ["routes"] });
    },
    onError: (e) => toast.error(e.message),
  });

  if (status.isPending) return <Skeleton className="h-48 w-full" />;
  if (status.isError) return <p className="text-destructive">{status.error.message}</p>;
  const s = status.data;
  const latest = s.config.latest;
  const errors = latest?.status === "invalid" ? (latest.issues?.errors ?? []) : [];
  const warnings = latest?.issues?.warnings ?? [];
  const total = Object.values(s.last24h).reduce((a, b) => a + (b ?? 0), 0);
  const coverage = teams.data?.reduce(
    (acc, t) => ({ linked: acc.linked + t.linked, total: acc.total + t.total }),
    { linked: 0, total: 0 },
  );

  return (
    <div className="space-y-4">
      {errors.length > 0 && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>
            The latest config push was rejected —{" "}
            {s.config.active ? "the previous version stays active" : "no config is active"}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc pl-4">
              {errors.map((e, i) => (
                <li key={i}>
                  <code>{[e.file, e.path.join(".")].filter(Boolean).join(":")}</code> — {e.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Config</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              {s.config.active ? (
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <CircleAlert className="size-4 text-destructive" />
              )}
              {s.config.active
                ? `${s.config.active.routes} routes · ${s.config.active.commitSha.slice(0, 7)}`
                : "No valid config"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span className="truncate">
              {s.configRepo}
              {latest ? ` · ${ago(latest.createdAt)}` : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => reload.mutate()}
              disabled={reload.isPending}
            >
              <RefreshCw className={reload.isPending ? "animate-spin" : ""} /> Reload
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Channels</CardDescription>
            <CardTitle className="space-y-1 text-base font-normal">
              <div className="flex items-center gap-2">
                <Hash className="size-4" />
                {s.slack ? (
                  <>
                    Slack <b>{s.slack.team}</b>
                    {s.slack.commands ? <Badge variant="secondary">/notify</Badge> : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">Slack not connected</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Send className="size-4" />
                {s.telegram ? (
                  <>
                    Telegram <b>@{s.telegram.bot}</b>
                  </>
                ) : (
                  <span className="text-muted-foreground">Telegram not connected</span>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s.slack?.lastSyncedAt
              ? `People synced ${ago(s.slack.lastSyncedAt)}`
              : "People not synced yet"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Last 24 hours</CardDescription>
            <CardTitle className="text-2xl">{total} notifications</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1">
            {Object.entries(s.last24h).map(([k, v]) => (
              <Badge
                key={k}
                variant={k === "failed" || k === "partially_failed" ? "destructive" : "secondary"}
              >
                {k.replace("_", " ")} {v}
              </Badge>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Teams</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4" />
              {coverage
                ? coverage.total > 0
                  ? `${coverage.linked}/${coverage.total} members linked`
                  : `${teams.data?.length ?? 0} teams, no members`
                : "…"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {coverage && coverage.linked < coverage.total
              ? "Unlinked members are mentioned as plain text — see Teams."
              : "Everyone in members_from is linked."}
          </CardContent>
        </Card>
      </div>
      {warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Config warnings</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {warnings.map((w, i) => (
              <div key={i}>
                <code>{w.file}</code> — {w.message}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
