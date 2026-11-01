import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Route, Send } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { MuteSwitch, RouteDestinations, RouteSources } from "@/components/route-parts";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { TestNotificationDialog } from "./admin/test-notification";

/** `admin`: also the template, the examples and a test send. */
export function RoutePage({ linked, admin }: { linked: boolean; admin: boolean }) {
  const { routeId } = useParams();
  const route = useQuery({
    queryKey: ["route", routeId],
    queryFn: () => api.route(routeId!),
    retry: false,
  });
  const [testing, setTesting] = useState(false);

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      <Link to="/routes">
        <ArrowLeft /> Routes
      </Link>
    </Button>
  );
  if (route.isPending) return <Skeleton className="h-64 w-full" />;
  if (route.isError) {
    return (
      <div className="space-y-2">
        {back}
        {route.error instanceof ApiError && route.error.status === 404 ? (
          <EmptyState icon={Route} title={`No route “${routeId}”`}>
            It is not in the active config.
          </EmptyState>
        ) : (
          <ErrorState error={route.error} retry={() => void route.refetch()} />
        )}
      </div>
    );
  }
  const r = route.data;

  return (
    <div className="space-y-4">
      {back}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{r.id}</CardTitle>
            {r.description && <CardDescription>{r.description}</CardDescription>}
          </div>
          <div className="flex shrink-0 gap-2">
            {admin && (
              <Button size="sm" onClick={() => setTesting(true)}>
                <Send /> Send test
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <a href={r.url} target="_blank" rel="noreferrer">
                <ExternalLink /> Open in GitHub
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Delivers to</dt>
            <dd className="flex flex-wrap gap-1">
              <RouteDestinations route={r} />
            </dd>
            <dt className="text-muted-foreground">Who can send</dt>
            <dd className="flex flex-col gap-1">
              <RouteSources route={r} />
            </dd>
            {r.dataFields.length > 0 && (
              <>
                <dt className="text-muted-foreground">Data</dt>
                <dd className="flex flex-wrap gap-1">
                  {r.dataFields.map((f) => (
                    <code key={f} className="rounded bg-muted px-1">
                      {f}
                    </code>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Mentions</dt>
            <dd>{r.mentions === "recipients" ? "The recipients of each notification" : "None"}</dd>
            <dt className="text-muted-foreground">Personal copies</dt>
            <dd>
              {r.dm ? (
                <span className="flex items-center gap-2">
                  <MuteSwitch route={r} linked={linked} />
                  {r.muted ? "muted for you" : "sent to you as a direct message"}
                </span>
              ) : (
                <Badge variant="outline">channel only</Badge>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      {admin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Template and examples</CardTitle>
            <CardDescription>
              What the route renders, and the data “Send test” uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Code title="Template" value={r.template ?? r.slackBlocks} />
            {r.examples?.length ? <Code title="Examples" value={r.examples} /> : null}
          </CardContent>
        </Card>
      )}
      {testing && <TestNotificationDialog route={r.id} onClose={() => setTesting(false)} />}
    </div>
  );
}

function Code({ title, value }: { title: string; value: unknown }) {
  return (
    <section>
      <h3 className="mb-2 font-medium">{title}</h3>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
