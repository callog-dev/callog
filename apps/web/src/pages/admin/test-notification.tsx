import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { adminApi, api, type NotificationDetails } from "@/lib/api";

/** The release of the GitHub Action the snippet pins; bump it with every release. */
const ACTION_REF = "callog-dev/callog/packages/action@v0.1.2";
const POLL_MS = 1_000;
const FINAL = new Set(["delivered", "partially_failed", "failed"]);

export function TestNotificationDialog({ onClose }: { onClose: () => void }) {
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });
  const [routeId, setRouteId] = useState<string>();
  const [sent, setSent] = useState<string>();
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: () => adminApi.testRoute(routeId!),
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
  useEffect(() => {
    if (!routeId && first) setRouteId(first);
  }, [routeId, first]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test notification</DialogTitle>
          <DialogDescription>
            The route's first example goes through the real pipeline and mentions you.
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
              disabled={!selected || send.isPending || (Boolean(sent) && !done)}
              onClick={() => send.mutate()}
            >
              {sent ? "Send again" : "Send"}
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
