import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { actionsColumn, DataTable, type ColumnDef } from "@/components/data-table";
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
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, type ApiKeyInfo } from "@/lib/api";
import { ago } from "@/lib/time";

export function ApiKeysTab() {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ["admin", "api-keys"], queryFn: adminApi.apiKeys });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => adminApi.createApiKey(name.trim()),
    onSuccess: (k) => {
      setCreated(k.key);
      void client.invalidateQueries({ queryKey: ["admin", "api-keys"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const confirm = useConfirm();
  const revoke = useMutation({
    mutationFn: adminApi.revokeApiKey,
    onSuccess: (_, n) => {
      toast.success(`Revoked ${n}`);
      void client.invalidateQueries({ queryKey: ["admin", "api-keys"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const close = () => {
    setCreating(false);
    setCreated(null);
    setName("");
  };

  const { mutate: revokeKey } = revoke;
  const columns = useMemo(
    () =>
      apiKeyColumns(async (k) => {
        const ok = await confirm({
          title: `Revoke the key ${k.name}?`,
          description: "Services using it stop being able to send notifications at once.",
          action: "Revoke",
          destructive: true,
        });
        if (ok) revokeKey(k.name);
      }),
    [confirm, revokeKey],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">API keys</CardTitle>
          <CardDescription>
            For backend services. Allow a key on a route with{" "}
            <code>allowed_sources.api_keys: [name]</code>. GitHub Actions need no key (OIDC).
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New key
        </Button>
      </CardHeader>
      <CardContent>
        {keys.isPending ? (
          <Skeleton className="h-24" />
        ) : keys.isError ? (
          <ErrorState error={keys.error} retry={() => void keys.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={keys.data}
            getRowId={(k) => k.id}
            rowClassName={(k) => (k.revokedAt ? "opacity-50" : undefined)}
            empty={
              <EmptyState icon={KeyRound} title="No API keys yet">
                Services outside GitHub Actions send notifications with a key.
              </EmptyState>
            }
          />
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{created ? "Copy the key now" : "New API key"}</DialogTitle>
            <DialogDescription>
              {created
                ? "It will not be shown again. Store it as a secret of the service that sends notifications."
                : "Name it after the service that will use it."}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="flex gap-2">
              <Input
                readOnly
                value={created}
                className="font-mono text-xs"
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy key"
                onClick={() =>
                  navigator.clipboard.writeText(created).then(() => toast.success("Copied"))
                }
              >
                <Copy />
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                placeholder="billing"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            {created ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
                Create
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function apiKeyColumns(revoke: (key: ApiKeyInfo) => void): ColumnDef<ApiKeyInfo>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-medium">
          <KeyRound className="mr-1 inline size-3.5" />
          {row.original.name}
        </span>
      ),
    },
    {
      accessorKey: "prefix",
      header: "Key",
      enableSorting: false,
      cell: ({ row }) => <code>{row.original.prefix}…</code>,
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      meta: { className: "text-muted-foreground" },
      cell: ({ row }) => ago(row.original.createdAt),
    },
    {
      accessorKey: "lastUsedAt",
      header: "Last used",
      meta: { className: "text-muted-foreground" },
      cell: ({ row }) => (row.original.lastUsedAt ? ago(row.original.lastUsedAt) : "never"),
    },
    actionsColumn((k) =>
      k.revokedAt ? (
        <Badge variant="outline">revoked</Badge>
      ) : (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(k)}>
          Revoke
        </Button>
      ),
    ),
  ];
}
