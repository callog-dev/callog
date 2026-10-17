import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminApi, type Me } from "@/lib/api";
import { ago } from "@/lib/time";

/** Who can open /manage: GitHub org owners (always) and people granted the role here. */
export function AdminsTab({ me }: { me: Me }) {
  const client = useQueryClient();
  const admins = useQuery({ queryKey: ["admin", "admins"], queryFn: adminApi.admins });
  const people = useQuery({ queryKey: ["admin", "people"], queryFn: adminApi.people });
  const [granting, setGranting] = useState(false);
  const [personId, setPersonId] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["admin", "admins"] });
  const grant = useMutation({
    mutationFn: () => adminApi.grantAdmin(personId),
    onSuccess: () => {
      toast.success("Admin role granted");
      setGranting(false);
      setPersonId("");
      void refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: adminApi.revokeAdmin,
    onSuccess: () => (toast.success("Admin role revoked"), void refresh()),
    onError: (e) => toast.error(e.message),
  });

  if (admins.isPending) return <Skeleton className="h-64 w-full" />;
  if (admins.isError) return <p className="text-destructive">{admins.error.message}</p>;
  const adminIds = new Set(admins.data.admins.map((a) => a.person.id));
  const candidates = (people.data ?? []).filter(
    (p) => p.status === "active" && !adminIds.has(p.id),
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub org owners</CardTitle>
          <CardDescription>
            Owners of <code>{me.org}</code> are always admins here; manage them on GitHub.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {admins.data.owners.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Could not list owners — GitHub is unavailable or the app lacks members:read.
            </p>
          )}
          {admins.data.owners.map((o) => (
            <Badge key={o.login} variant="secondary" title={o.person ? undefined : "not linked"}>
              <ShieldCheck className="size-3" /> {o.person?.name ?? `@${o.login}`}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Admins</CardTitle>
            <CardDescription>
              Granted here, to a person rather than an account. The role ends when the person leaves
              Slack.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setGranting(true)}>
            <Plus /> Grant
          </Button>
        </CardHeader>
        <CardContent>
          {admins.data.admins.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Granted by</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.data.admins.map((a) => (
                  <TableRow key={a.person.id}>
                    <TableCell className="font-medium">
                      {a.person.name}
                      {a.person.id === me.person?.id && (
                        <Badge variant="outline" className="ml-2">
                          you
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.grantedBy ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{ago(a.grantedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => revoke.mutate(a.person.id)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nobody besides the org owners yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit log</CardTitle>
          <CardDescription>Role changes, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {admins.data.audit.length ? (
            <ul className="space-y-1 text-sm">
              {admins.data.audit.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-28 shrink-0 text-muted-foreground">{ago(e.createdAt)}</span>
                  <span>
                    {e.action === "admin.granted" ? "Granted to" : "Revoked from"}{" "}
                    <b>{e.subject ?? "a deleted person"}</b>
                    {e.actor
                      ? ` by ${e.actor}`
                      : e.details?.reason === "inactive"
                        ? " — person left"
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">No changes yet.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={granting} onOpenChange={(o) => !o && setGranting(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant the admin role</DialogTitle>
            <DialogDescription>
              Admins see every delivery (including payloads), link accounts and manage keys.
            </DialogDescription>
          </DialogHeader>
          <Select value={personId} onValueChange={setPersonId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a person" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGranting(false)}>
              Cancel
            </Button>
            <Button disabled={!personId || grant.isPending} onClick={() => grant.mutate()}>
              Grant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
