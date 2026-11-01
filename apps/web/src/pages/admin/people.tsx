import { useQuery } from "@tanstack/react-query";
import { Check, CheckCircle2, Link2, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router";
import { actionsColumn, DataTable, useUrlTableView, type ColumnDef } from "@/components/data-table";
import { FilterSelect } from "@/components/filter-select";
import { PersonName } from "@/components/person-name";
import { RouteTabs } from "@/components/route-tabs";
import { ProviderBadge } from "@/components/provider-badge";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlState } from "@/hooks/use-url-state";
import { adminApi, type AdminPerson, type SuggestedLink, type UnmappedRow } from "@/lib/api";
import { ago } from "@/lib/time";
import { LinkDialog, useIdentityActions } from "./link-dialog";
import { PersonPage } from "./person";

/** `/manage/people/*`: the directory, unmapped recipients, suggested links and a person. */
export function PeoplePage() {
  return (
    <Routes>
      <Route element={<PeopleTabs />}>
        <Route index element={<Directory />} />
        <Route path="unmapped" element={<Unmapped />} />
        <Route path="suggested" element={<Suggested />} />
      </Route>
      <Route path=":personId" element={<PersonPage />} />
      <Route path="*" element={<Navigate to="/manage/people" replace />} />
    </Routes>
  );
}

function PeopleTabs() {
  const unmapped = useQuery({ queryKey: ["admin", "unmapped"], queryFn: adminApi.unmapped });
  const suggested = useQuery({
    queryKey: ["admin", "suggested-links"],
    queryFn: adminApi.suggestedLinks,
  });
  return (
    <RouteTabs
      tabs={[
        { url: "/manage/people", title: "Everyone" },
        { url: "/manage/people/unmapped", title: "Unmapped", count: unmapped.data?.length },
        {
          url: "/manage/people/suggested",
          title: "Suggested links",
          count: suggested.data?.length,
        },
      ]}
    />
  );
}

const STATUS = { status: "active" };

function Directory() {
  const view = useUrlTableView();
  const [filters, setFilters] = useUrlState(STATUS);
  const [linking, setLinking] = useState(false);
  const navigate = useNavigate();
  const [{ q, page }] = view;
  const people = useQuery({
    queryKey: ["admin", "people", { q, page, status: filters.status }],
    queryFn: () => adminApi.people({ q, page, status: filters.status }),
    placeholderData: (previous) => previous,
  });

  if (people.isPending) return <Skeleton className="h-64 w-full" />;
  if (people.isError)
    return <ErrorState error={people.error} retry={() => void people.refetch()} />;
  const { items, total, pageSize } = people.data;

  return (
    <>
      <DataTable
        columns={PEOPLE_COLUMNS}
        data={items}
        getRowId={(p) => p.id}
        onRowClick={(p) => navigate(`/manage/people/${p.id}`)}
        search="Search by name or account"
        view={view}
        manual={{ pageCount: Math.max(1, Math.ceil(total / pageSize)) }}
        toolbar={
          <>
            <FilterSelect
              label="Status"
              value={filters.status}
              onChange={(status) => {
                setFilters({ status });
                view[1]({ page: "1" });
              }}
              options={[
                ["active", "Active"],
                ["inactive", "Left"],
                ["all", "Everyone"],
              ]}
            />
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setLinking(true)}
            >
              <Link2 /> Link account
            </Button>
          </>
        }
        empty={
          <EmptyState icon={Users} title="Nobody here yet">
            People are imported from Slack once it is connected.
          </EmptyState>
        }
      />
      {linking && <LinkDialog initialRef="" onClose={() => setLinking(false)} />}
    </>
  );
}

const PEOPLE_COLUMNS: ColumnDef<AdminPerson>[] = [
  {
    accessorKey: "name",
    header: "Name",
    enableSorting: false,
    meta: { className: "w-56 align-top font-medium" },
    cell: ({ row: { original: p } }) => <PersonName name={p.name} status={p.status} />,
  },
  {
    id: "accounts",
    header: "Accounts",
    cell: ({ row: { original: p } }) => (
      <div className="flex flex-wrap gap-1">
        {p.identities.map((i) => (
          <ProviderBadge key={i.id} provider={i.provider}>
            {i.handle ?? i.externalId}
            {i.confidence === "suggested" ? " ?" : ""}
          </ProviderBadge>
        ))}
      </div>
    ),
  },
];

const LINKABLE = /^(github|email|slack|telegram):/;

function Unmapped() {
  const unmapped = useQuery({ queryKey: ["admin", "unmapped"], queryFn: adminApi.unmapped });
  const [linking, setLinking] = useState<string | null>(null);
  const columns = useMemo(() => unmappedColumns(setLinking), []);

  if (unmapped.isPending) return <Skeleton className="h-48 w-full" />;
  if (unmapped.isError) {
    return <ErrorState error={unmapped.error} retry={() => void unmapped.refetch()} />;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Mentioned as plain text because nobody is linked to them.
      </p>
      <DataTable
        columns={columns}
        data={unmapped.data}
        getRowId={(u) => `${u.ref}${u.provider}`}
        empty={<EmptyState icon={CheckCircle2} title="Everyone mentioned recently is linked" />}
      />
      {linking !== null && <LinkDialog initialRef={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

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

function Suggested() {
  const links = useQuery({
    queryKey: ["admin", "suggested-links"],
    queryFn: adminApi.suggestedLinks,
  });
  const { confirm, unlink } = useIdentityActions();
  const columns = useMemo(() => suggestedColumns(confirm, unlink), [confirm, unlink]);

  if (links.isPending) return <Skeleton className="h-48 w-full" />;
  if (links.isError) return <ErrorState error={links.error} retry={() => void links.refetch()} />;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Guessed from commit history; confirm them before they are used for mentions.
      </p>
      <DataTable
        columns={columns}
        data={links.data}
        getRowId={(l) => l.id}
        empty={<EmptyState icon={CheckCircle2} title="No guesses to review" />}
      />
    </>
  );
}

function suggestedColumns(
  confirm: (id: string) => void,
  reject: (id: string) => void,
): ColumnDef<SuggestedLink>[] {
  return [
    {
      id: "account",
      header: "Account",
      cell: ({ row: { original: l } }) => (
        <ProviderBadge provider={l.provider}>{l.handle ?? l.externalId}</ProviderBadge>
      ),
    },
    {
      id: "person",
      header: "Probably",
      cell: ({ row: { original: l } }) => (
        <Link
          to={`/manage/people/${l.person.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {l.person.name}
        </Link>
      ),
    },
    actionsColumn((l) => (
      <span className="inline-flex gap-1">
        <Button size="sm" variant="outline" onClick={() => confirm(l.id)}>
          <Check /> Confirm
        </Button>
        <Button size="sm" variant="ghost" onClick={() => reject(l.id)}>
          <X /> Reject
        </Button>
      </span>
    )),
  ];
}
