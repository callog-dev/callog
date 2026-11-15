import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Webhook } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { actionsColumn, DataTable, type ColumnDef } from "@/components/data-table";
import { RouteLink } from "@/components/route-parts";
import { SecretOnce } from "@/components/secret-once";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, api, type HookInfo } from "@/lib/api";
import { ago } from "@/lib/time";

const HOOKS = ["admin", "hooks"];

/** Inbound webhooks: a secret URL per sending system, each bound to one route. */
export function HooksTab() {
  const client = useQueryClient();
  const hooks = useQuery({ queryKey: HOOKS, queryFn: adminApi.hooks });
  const routes = useQuery({ queryKey: ["routes"], queryFn: api.routes });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [route, setRoute] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => adminApi.createHook(name.trim(), route),
    onSuccess: (hook) => {
      // The server returns the path; the host is the one this page was opened on.
      setUrl(`${window.location.origin}${hook.path}`);
      void client.invalidateQueries({ queryKey: HOOKS });
    },
    onError: (e) => toast.error(e.message),
  });
  const confirm = useConfirm();
  const { mutate: revokeHook } = useMutation({
    mutationFn: adminApi.revokeHook,
    onSuccess: (_, n) => {
      toast.success(`Revoked ${n}`);
      void client.invalidateQueries({ queryKey: HOOKS });
    },
    onError: (e) => toast.error(e.message),
  });
  const close = () => {
    setCreating(false);
    setUrl(null);
    setName("");
    setRoute("");
  };

  const columns = useMemo(
    () =>
      hookColumns(async (hook) => {
        const ok = await confirm({
          title: `Revoke the hook ${hook.name}?`,
          description: "The system posting to its URL is refused at once.",
          action: "Revoke",
          destructive: true,
        });
        if (ok) revokeHook(hook.name);
      }),
    [confirm, revokeHook],
  );
  const routeIds = (routes.data?.routes ?? []).map((r) => r.id);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Hooks</CardTitle>
          <CardDescription>
            For systems that send their own webhooks and cannot hold a key: an alerting tool posts
            any JSON to the hook&apos;s URL, and the route decides who hears about it.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New hook
        </Button>
      </CardHeader>
      <CardContent>
        {hooks.isPending ? (
          <Skeleton className="h-24" />
        ) : hooks.isError ? (
          <ErrorState error={hooks.error} retry={() => void hooks.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={hooks.data}
            getRowId={(hook) => hook.id}
            rowClassName={(hook) => (hook.revokedAt ? "opacity-50" : undefined)}
            empty={
              <EmptyState icon={Webhook} title="No hooks yet">
                A hook gives a system that cannot sign requests a URL to post to.
              </EmptyState>
            }
          />
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{url ? "Copy the URL now" : "New hook"}</DialogTitle>
            <DialogDescription>
              {url
                ? "It will not be shown again, and anyone who has it can post to the route. Paste it into the system that sends."
                : "Name it after the system that will post to it, and pick the route its posts go to."}
            </DialogDescription>
          </DialogHeader>
          {url ? (
            <div className="space-y-2">
              <SecretOnce value={url} label="hook URL" />
              <p className="text-sm text-muted-foreground">
                If the sending system reaches Callog at another address, keep the path and replace
                the host.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="hook-name">Name</Label>
                <Input
                  id="hook-name"
                  value={name}
                  placeholder="grafana"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hook-route">Route</Label>
                <Select value={route} onValueChange={setRoute} disabled={routeIds.length === 0}>
                  <SelectTrigger id="hook-route" className="w-full">
                    <SelectValue
                      placeholder={
                        routes.isPending
                          ? "Loading routes…"
                          : routeIds.length > 0
                            ? "Pick a route"
                            : "The config has no routes yet"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {routeIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            {url ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <Button
                onClick={() => create.mutate()}
                disabled={!name.trim() || !route || create.isPending}
              >
                Create
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function hookColumns(revoke: (hook: HookInfo) => void): ColumnDef<HookInfo>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-medium">
          <Webhook className="mr-1 inline size-3.5" />
          {row.original.name}
        </span>
      ),
    },
    {
      accessorKey: "routeId",
      header: "Route",
      cell: ({ row }) =>
        row.original.routeMissing ? (
          <span className="text-destructive" title="Posts to this hook are refused">
            {row.original.routeId} — not in the config
          </span>
        ) : (
          <RouteLink id={row.original.routeId} />
        ),
    },
    {
      accessorKey: "prefix",
      header: "Token",
      enableSorting: false,
      cell: ({ row }) => <code>{row.original.prefix}…</code>,
    },
    {
      accessorKey: "lastUsedAt",
      header: "Last used",
      meta: { className: "text-muted-foreground" },
      cell: ({ row }) => (row.original.lastUsedAt ? ago(row.original.lastUsedAt) : "never"),
    },
    actionsColumn((hook) =>
      hook.revokedAt ? (
        <Badge variant="outline">revoked</Badge>
      ) : (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(hook)}>
          Revoke
        </Button>
      ),
    ),
  ];
}
