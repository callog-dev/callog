import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, KeyRound, UserRound } from "lucide-react";
import { toast } from "sonner";
import { ProviderBadge } from "@/components/provider-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type RouteSummary } from "@/lib/api";

export function RoutesPage() {
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });
  const client = useQueryClient();
  const toggle = useMutation({
    mutationFn: (r: RouteSummary) => (r.muted ? api.unmute(r.id) : api.mute(r.id)),
    onSuccess: (_, r) => {
      toast.success(
        r.muted ? `Personal copies of ${r.id} are back on` : `Muted personal copies of ${r.id}`,
      );
      void client.invalidateQueries({ queryKey: ["routes"] });
      void client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (routes.isPending) return <Skeleton className="h-64 w-full" />;
  if (routes.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load routes</AlertTitle>
        <AlertDescription>{routes.error.message}</AlertDescription>
      </Alert>
    );
  }
  const { configRepo, commitSha } = routes.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Routes</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1">
          From <GitBranch className="size-3.5" />
          <a
            className="underline-offset-4 hover:underline"
            href={`https://github.com/${configRepo}`}
            target="_blank"
            rel="noreferrer"
          >
            {configRepo}
          </a>
          {commitSha ? (
            <code className="rounded bg-muted px-1 text-xs">{commitSha.slice(0, 7)}</code>
          ) : (
            " — no valid config yet"
          )}
          . Change them with a pull request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {routes.data.routes.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No routes in the config repo yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Route</TableHead>
                <TableHead>Delivers to</TableHead>
                <TableHead>Who can send</TableHead>
                <TableHead className="text-right">My copies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.data.routes.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="align-top">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                    >
                      {r.id} <ExternalLink className="size-3 text-muted-foreground" />
                    </a>
                    {r.description && (
                      <div className="text-sm text-muted-foreground">{r.description}</div>
                    )}
                    {r.dataFields.length > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        data:{" "}
                        {r.dataFields.map((f) => (
                          <code key={f} className="mr-1">
                            {f}
                          </code>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap gap-1">
                      {r.destinations.map((d) => (
                        <ProviderBadge
                          key={`${d.provider}${d.destination}`}
                          provider={d.provider}
                          title={d.label ? d.destination : undefined}
                        >
                          {d.label ?? d.destination}
                        </ProviderBadge>
                      ))}
                      {r.dm && <Badge variant="outline">+ personal copies</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-1 text-sm">
                      {r.allowedSources.github_repos.map((repo) => (
                        <span key={repo} className="inline-flex items-center gap-1">
                          <GitBranch className="size-3" />
                          {repo}
                        </span>
                      ))}
                      {r.allowedSources.api_keys.map((k) => (
                        <span key={k} className="inline-flex items-center gap-1">
                          <KeyRound className="size-3" />
                          {k}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {r.dm ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Switch
                              checked={!r.muted}
                              disabled={toggle.isPending}
                              onCheckedChange={() => toggle.mutate(r)}
                              aria-label={`Personal copies of ${r.id}`}
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Mentions in channels stay either way</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <UserRound className="size-3" />
                        channel only
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
