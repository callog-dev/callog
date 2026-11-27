import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { ProviderBadge } from "@/components/provider-badge";
import { DestinationBadge } from "@/components/route-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminApi,
  api,
  type NotificationDetails,
  type TargetRoom,
  type TestTarget,
} from "@/lib/api";

/** The release of the GitHub Action the snippet pins; bump it with every release. */
const ACTION_REF = "callog-dev/callog/packages/action@v0.5.1";
const POLL_MS = 1_000;
const FINAL = new Set(["delivered", "partially_failed", "failed"]);

/** `route` preselects a route. */
export function TestNotificationDialog({
  route,
  onClose,
}: {
  route?: string;
  onClose: () => void;
}) {
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });
  const [routeId, setRouteId] = useState(route);
  const [sent, setSent] = useState<string>();
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: (configVersion: string) => adminApi.testRoute(routeId!, configVersion),
    onSuccess: ({ notificationId }) => setSent(notificationId),
    onError: (e) => toast.error(e.message),
  });
  const result = useQuery({
    queryKey: ["admin", "notification", sent],
    queryFn: () => adminApi.notification(sent!),
    enabled: Boolean(sent),
    refetchInterval: (q) => (q.state.data && FINAL.has(q.state.data.status) ? false : POLL_MS),
  });
  const done = result.data && FINAL.has(result.data.status);
  useEffect(() => {
    if (done) void client.invalidateQueries({ queryKey: ["admin", "onboarding"] });
  }, [done, client]);

  const first = routes.data?.routes[0]?.id;
  const selected = routeId ?? first;
  const confirm = useConfirm();
  const [asking, setAsking] = useState(false);
  const confirmAndSend = async () => {
    setAsking(true);
    // Asked on every press: people link accounts and the config changes in between.
    const preview = await client
      .fetchQuery({
        queryKey: ["admin", "test-targets", selected],
        queryFn: () => adminApi.testTargets(selected!),
        staleTime: 0,
      })
      .catch((e: Error) => void toast.error(e.message))
      .finally(() => setAsking(false));
    if (!preview) return;
    const where = preview.targets;
    const confirmed = await confirm({
      title: `Send a test of ${selected}?`,
      description:
        where.length > 0
          ? "A real notification is posted to:"
          : "The route has nowhere to post it: the notification will fail.",
      body: where.length > 0 && <Targets targets={where} />,
      action: "Send",
    });
    if (confirmed) send.mutate(preview.configVersion);
  };
  useEffect(() => {
    if (!routeId && first) setRouteId(first);
  }, [routeId, first]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test notification</DialogTitle>
          <DialogDescription>
            The route's first example goes through the real pipeline: it is posted wherever the
            route delivers, and mentions you if the route mentions its recipients.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label>Route</Label>
              <Select
                value={selected}
                onValueChange={(v) => {
                  setRouteId(v);
                  setSent(undefined);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No routes loaded" />
                </SelectTrigger>
                <SelectContent>
                  {routes.data?.routes.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!selected || asking || send.isPending || (Boolean(sent) && !done)}
              onClick={confirmAndSend}
            >
              {sent ? "Send again" : "Send test"}
            </Button>
          </div>
          {result.data && <Outcome notification={result.data} />}
          {result.data && done && result.data.status !== "failed" && (
            <Snippet route={result.data.route} data={result.data.data} />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where the test is about to be posted, for the admin to confirm. */
function Targets({ targets }: { targets: TestTarget[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {targets.map((t) => (
        <li
          key={`${t.provider}${t.kind}${t.destination}`}
          className="flex flex-wrap items-center gap-2"
        >
          <Room room={t} />
          {t.for.length > 0 && (
            <span className="text-muted-foreground">
              {t.kind === "person" ? "a personal copy for" : "in place of a personal copy for"}{" "}
              {t.for.map((recipient) => recipient.name).join(", ")}
            </span>
          )}
          {t.fallbacks.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1 text-muted-foreground">
              if that fails:
              {t.fallbacks.map((f) => (
                <Room key={`${f.provider}${f.kind}${f.destination}`} room={f} />
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Room({ room }: { room: TargetRoom }) {
  return room.kind === "person" ? (
    <ProviderBadge provider={room.provider} />
  ) : (
    <DestinationBadge {...room} />
  );
}

function Outcome({ notification: n }: { notification: NotificationDetails }) {
  if (!FINAL.has(n.status)) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Delivering…
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {n.deliveries.map((d) => (
        <li key={`${d.provider}${d.destination}`} className="flex items-start gap-2">
          {d.status === "sent" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <span>
            {d.provider} {d.destination}
            {d.lastError && <span className="text-muted-foreground"> — {d.lastError}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Snippet({ route, data }: { route: string; data: Record<string, unknown> }) {
  const yaml = [
    `- uses: ${ACTION_REF}`,
    "  with:",
    `    url: ${window.location.origin}`,
    `    route: ${route}`,
    ...(Object.keys(data).length > 0 ? [`    data: '${JSON.stringify(data)}'`] : []),
  ].join("\n");
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>Send it from a workflow</Label>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy the step"
          onClick={() => navigator.clipboard.writeText(yaml).then(() => toast.success("Copied"))}
        >
          <Copy />
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{yaml}</pre>
      <p className="text-muted-foreground">
        The job needs <code>permissions: id-token: write</code>, and the route must list the
        repository in <code>allowed_sources.github_repos</code>.
      </p>
    </div>
  );
}
