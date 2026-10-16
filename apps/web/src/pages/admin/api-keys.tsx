import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminApi } from "@/lib/api";
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
        ) : keys.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((k) => (
                <TableRow key={k.id} className={k.revokedAt ? "opacity-50" : ""}>
                  <TableCell className="font-medium">
                    <KeyRound className="mr-1 inline size-3.5" />
                    {k.name}
                  </TableCell>
                  <TableCell>
                    <code>{k.prefix}…</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ago(k.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.lastUsedAt ? ago(k.lastUsedAt) : "never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {k.revokedAt ? (
                      <Badge variant="outline">revoked</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => revoke.mutate(k.name)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-4 text-center text-sm text-muted-foreground">No API keys yet.</p>
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
