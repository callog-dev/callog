import { useQuery } from "@tanstack/react-query";
import { GitBranch, UserRound } from "lucide-react";
import { Link } from "react-router";
import { MuteSwitch, RouteDestinations, RouteSources } from "@/components/route-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

/** `linked`: personal copies belong to a person, so an unlinked owner cannot mute them. */
export function RoutesPage({ linked }: { linked: boolean }) {
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });

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
                    <Link
                      to={`/routes/${encodeURIComponent(r.id)}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {r.id}
                    </Link>
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
                      <RouteDestinations route={r} />
                      {r.dm && <Badge variant="outline">+ personal copies</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-1 text-sm">
                      <RouteSources route={r} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {r.dm ? (
                      <MuteSwitch route={r} linked={linked} />
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
