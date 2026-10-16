import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProviderBadge } from "@/components/provider-badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminApi, type AdminPerson } from "@/lib/api";
import { ago } from "@/lib/time";

export function PeopleTab() {
  const client = useQueryClient();
  const people = useQuery({ queryKey: ["admin", "people"], queryFn: adminApi.people });
  const unmapped = useQuery({ queryKey: ["admin", "unmapped"], queryFn: adminApi.unmapped });
  const [linking, setLinking] = useState<{ ref: string } | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["admin", "people"] });
    void client.invalidateQueries({ queryKey: ["admin", "unmapped"] });
  };
  const confirm = useMutation({
    mutationFn: adminApi.confirmIdentity,
    onSuccess: () => (toast.success("Confirmed"), refresh()),
    onError: (e) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: adminApi.unlinkIdentity,
    onSuccess: () => (toast.success("Unlinked"), refresh()),
    onError: (e) => toast.error(e.message),
  });

  if (people.isPending || unmapped.isPending) return <Skeleton className="h-64 w-full" />;
  if (people.isError) return <p className="text-destructive">{people.error.message}</p>;
  const suggested = people.data.flatMap((p) =>
    p.identities
      .filter((i) => i.confidence === "suggested")
      .map((i) => ({ person: p, identity: i })),
  );

  return (
    <div className="space-y-4">
      {suggested.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Suggested links</CardTitle>
            <CardDescription>
              Guessed from commit history — confirm before they are used for mentions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggested.map(({ person, identity }) => (
              <div key={identity.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm">
                  <ProviderBadge provider={identity.provider}>
                    {identity.handle ?? identity.externalId}
                  </ProviderBadge>{" "}
                  → <b>{person.name}</b>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => confirm.mutate(identity.id)}>
                    <Check /> Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => unlink.mutate(identity.id)}>
                    <X /> Reject
                  </Button>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unmapped recipients</CardTitle>
          <CardDescription>
            Mentioned as plain text because nobody is linked to them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unmapped.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Times</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmapped.data.map((u) => (
                  <TableRow key={`${u.ref}${u.provider}`}>
                    <TableCell>
                      <code>{u.ref}</code>
                      {u.reason && <div className="text-xs text-muted-foreground">{u.reason}</div>}
                    </TableCell>
                    <TableCell>
                      <ProviderBadge provider={u.provider} />
                    </TableCell>
                    <TableCell>{u.occurrences}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {ago(u.lastSeenAt)}
                      {u.lastRoute ? ` · ${u.lastRoute}` : ""}
                    </TableCell>
                    <TableCell className="text-right">
                      {/^(github|email|slack|telegram):/.test(u.ref) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setLinking({ ref: u.ref })}
                        >
                          <Link2 /> Link
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Everyone mentioned recently is linked. 🎉
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">People</CardTitle>
            <CardDescription>
              Imported from Slack; accounts linked automatically, by people themselves or here.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setLinking({ ref: "" })}>
            <Link2 /> Link account
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {people.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="w-48 align-top font-medium">
                    {p.name}
                    {p.status === "inactive" && (
                      <Badge variant="outline" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {p.identities.map((i) => (
                        <span
                          key={i.id}
                          className="group inline-flex items-center"
                          title={`${i.confidence} via ${i.source}`}
                        >
                          <ProviderBadge provider={i.provider}>
                            {i.handle ?? i.externalId}
                            {i.confidence === "suggested" ? " ?" : ""}
                          </ProviderBadge>
                          <button
                            className="ml-0.5 hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline"
                            aria-label={`Unlink ${i.provider}`}
                            onClick={() => unlink.mutate(i.id)}
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {linking && (
        <LinkDialog
          initialRef={linking.ref}
          people={people.data}
          onClose={() => setLinking(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

export function LinkDialog({
  initialRef,
  people,
  onClose,
  onDone,
}: {
  initialRef: string;
  people: AdminPerson[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [ref, setRef] = useState(initialRef);
  const [personId, setPersonId] = useState<string>();
  const link = useMutation({
    mutationFn: () => adminApi.link(personId!, ref.trim()),
    onSuccess: () => {
      toast.success(`Linked ${ref}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an account</DialogTitle>
          <DialogDescription>
            Admin links are trusted as verified — make sure the account is theirs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ref">Account</Label>
            <Input
              id="ref"
              value={ref}
              placeholder="github:octocat, email:…, telegram:<user id>"
              onChange={(e) => setRef(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Person</Label>
            <Select value={personId} onValueChange={setPersonId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectContent>
                {people
                  .filter((p) => p.status === "active")
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => link.mutate()}
            disabled={!personId || !ref.trim() || link.isPending}
          >
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
