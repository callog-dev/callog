import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Link2, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { actionsColumn, DataTable, useUrlTableView, type ColumnDef } from "@/components/data-table";
import { PersonName } from "@/components/person-name";
import { ProviderBadge } from "@/components/provider-badge";
import { EmptyState, ErrorState } from "@/components/states";
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
import { adminApi, type AdminPerson, type UnmappedRow } from "@/lib/api";
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
  const confirmLink = useMutation({
    mutationFn: adminApi.confirmIdentity,
    onSuccess: () => (toast.success("Confirmed"), refresh()),
    onError: (e) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: adminApi.unlinkIdentity,
    onSuccess: () => (toast.success("Unlinked"), refresh()),
    onError: (e) => toast.error(e.message),
  });

  const confirm = useConfirm();
  const { mutate: unlinkIdentity } = unlink;
  const view = useUrlTableView();
  const columns = useMemo(
    () => ({
      unmapped: unmappedColumns((ref) => setLinking({ ref })),
      people: peopleColumns(async (identity, person) => {
        const ok = await confirm({
          title: `Unlink ${identity.handle ?? identity.externalId} from ${person.name}?`,
          description: "Notifications stop mentioning them through this account.",
          action: "Unlink",
          destructive: true,
        });
        if (ok) unlinkIdentity(identity.id);
      }),
    }),
    [confirm, unlinkIdentity],
  );

  if (people.isPending || unmapped.isPending) return <Skeleton className="h-64 w-full" />;
  if (people.isError) {
    return <ErrorState error={people.error} retry={() => void people.refetch()} />;
  }
  if (unmapped.isError) {
    return <ErrorState error={unmapped.error} retry={() => void unmapped.refetch()} />;
  }
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => confirmLink.mutate(identity.id)}
                  >
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
          <DataTable
            columns={columns.unmapped}
            data={unmapped.data}
            getRowId={(u) => `${u.ref}${u.provider}`}
            empty={<EmptyState icon={CheckCircle2} title="Everyone mentioned recently is linked" />}
          />
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
          <DataTable
            columns={columns.people}
            data={people.data}
            getRowId={(p) => p.id}
            search="Search by name or account"
            view={view}
            empty={
              <EmptyState icon={Users} title="Nobody here yet">
                People are imported from Slack once it is connected.
              </EmptyState>
            }
          />
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

const LINKABLE = /^(github|email|slack|telegram):/;

function unmappedColumns(link: (ref: string) => void): ColumnDef<UnmappedRow>[] {
  return [
    {
      accessorKey: "ref",
      header: "Recipient",
      cell: ({ row: { original: u } }) => (
        <>
          <code>{u.ref}</code>
          {u.reason && <div className="text-xs text-muted-foreground">{u.reason}</div>}
        </>
      ),
    },
    {
      accessorKey: "provider",
      header: "In",
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    { accessorKey: "occurrences", header: "Times" },
    {
      accessorKey: "lastSeenAt",
      header: "Last seen",
      meta: { className: "text-muted-foreground" },
      cell: ({ row: { original: u } }) =>
        `${ago(u.lastSeenAt)}${u.lastRoute ? ` · ${u.lastRoute}` : ""}`,
    },
    actionsColumn(
      (u) =>
        LINKABLE.test(u.ref) && (
          <Button size="sm" variant="outline" onClick={() => link(u.ref)}>
            <Link2 /> Link
          </Button>
        ),
    ),
  ];
}

function peopleColumns(
  unlink: (identity: AdminPerson["identities"][number], person: AdminPerson) => void,
): ColumnDef<AdminPerson>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      meta: { className: "w-48 align-top font-medium" },
      cell: ({ row: { original: p } }) => <PersonName name={p.name} status={p.status} />,
    },
    {
      id: "accounts",
      header: "Accounts",
      enableSorting: false,
      // What the search box matches on.
      accessorFn: (p) => p.identities.map((i) => i.handle ?? i.externalId).join(" "),
      cell: ({ row: { original: p } }) => (
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
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                aria-label={`Unlink ${i.provider}`}
                onClick={() => unlink(i, p)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ),
    },
  ];
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
