import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Link2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { actionsColumn, DataTable, type ColumnDef } from "@/components/data-table";
import { PersonName } from "@/components/person-name";
import { ProviderBadge } from "@/components/provider-badge";
import { EmptyState, ErrorState } from "@/components/states";
import { adminApi, type TeamInfo } from "@/lib/api";
import { LinkDialog } from "./link-dialog";

/** Teams from teams.yaml and who `members_from` resolves to: read-only, link by hand. */
export function TeamsTab() {
  const teams = useQuery({ queryKey: ["admin", "teams"], queryFn: adminApi.teams });
  const [linking, setLinking] = useState<string | null>(null);

  if (teams.isPending) return <Skeleton className="h-64 w-full" />;
  if (teams.isError) return <ErrorState error={teams.error} retry={() => void teams.refetch()} />;
  if (teams.data.length === 0) {
    return (
      <EmptyState icon={Users} title="No teams yet">
        Teams come from <code>teams.yaml</code> in the config repo.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {teams.data.map((t) => (
        <TeamCard key={t.slug} team={t} onLink={setLinking} />
      ))}
      {linking !== null && <LinkDialog initialRef={linking} onClose={() => setLinking(null)} />}
    </div>
  );
}

function TeamCard({ team, onLink }: { team: TeamInfo; onLink: (ref: string) => void }) {
  const columns = useMemo(() => memberColumns(onLink), [onLink]);
  const sources = [
    team.membersFrom?.githubTeam && `GitHub team ${team.membersFrom.githubTeam}`,
    team.membersFrom?.slackUsergroup && `Slack group @${team.membersFrom.slackUsergroup}`,
  ].filter(Boolean);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> {team.slug}
            {team.total > 0 && (
              <Badge variant={team.linked === team.total ? "secondary" : "outline"}>
                {team.linked}/{team.total} linked
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="flex flex-wrap gap-x-3">
            {team.slackChannel && <span>Slack {team.slackChannel}</span>}
            {team.telegramChat && <span>Telegram {team.telegramChat}</span>}
            {sources.length > 0 && <span>· members from {sources.join(" + ")}</span>}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {team.reason ? (
          <p className="text-sm text-muted-foreground">{team.reason}</p>
        ) : (
          <DataTable
            columns={columns}
            data={team.members}
            getRowId={(m) => m.ref}
            empty={<p className="text-sm text-muted-foreground">The source has no members.</p>}
          />
        )}
      </CardContent>
    </Card>
  );
}

type Member = TeamInfo["members"][number];

function memberColumns(link: (ref: string) => void): ColumnDef<Member>[] {
  return [
    {
      accessorKey: "handle",
      header: "Account",
      cell: ({ row: { original: m } }) => (
        <ProviderBadge provider={m.provider}>{m.handle}</ProviderBadge>
      ),
    },
    {
      id: "person",
      header: "Person",
      accessorFn: (m) => m.person?.name ?? "",
      cell: ({ row: { original: m } }) =>
        m.person ? (
          <Link to={`/manage/people/${m.person.id}`} className="underline-offset-4 hover:underline">
            <PersonName name={m.person.name} status={m.person.status} />
          </Link>
        ) : (
          <span className="text-muted-foreground">not linked</span>
        ),
    },
    actionsColumn(
      (m) =>
        !m.person && (
          <Button size="sm" variant="outline" onClick={() => link(m.ref)}>
            <Link2 /> Link
          </Button>
        ),
    ),
  ];
}
