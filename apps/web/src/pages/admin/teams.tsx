import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProviderBadge } from "@/components/provider-badge";
import { adminApi, type TeamInfo } from "@/lib/api";
import { LinkDialog } from "./people";

/** Teams from teams.yaml and who `members_from` resolves to: read-only, link by hand. */
export function TeamsTab() {
  const client = useQueryClient();
  const teams = useQuery({ queryKey: ["admin", "teams"], queryFn: adminApi.teams });
  const people = useQuery({ queryKey: ["admin", "people"], queryFn: adminApi.people });
  const [linking, setLinking] = useState<string | null>(null);

  if (teams.isPending) return <Skeleton className="h-64 w-full" />;
  if (teams.isError) return <p className="text-destructive">{teams.error.message}</p>;
  if (teams.data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No teams in <code>teams.yaml</code> of the active config.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {teams.data.map((t) => (
        <TeamCard key={t.slug} team={t} onLink={setLinking} />
      ))}
      {linking !== null && people.data && (
        <LinkDialog
          initialRef={linking}
          people={people.data}
          onClose={() => setLinking(null)}
          onDone={() => {
            void client.invalidateQueries({ queryKey: ["admin", "teams"] });
            void client.invalidateQueries({ queryKey: ["admin", "people"] });
          }}
        />
      )}
    </div>
  );
}

function TeamCard({ team, onLink }: { team: TeamInfo; onLink: (ref: string) => void }) {
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
        ) : team.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">The source has no members.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Person</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.members.map((m) => (
                <TableRow key={m.ref}>
                  <TableCell>
                    <ProviderBadge provider={m.provider}>{m.handle}</ProviderBadge>
                  </TableCell>
                  <TableCell>
                    {m.person ? (
                      <>
                        {m.person.name}
                        {m.person.status === "inactive" && (
                          <Badge variant="outline" className="ml-2">
                            inactive
                          </Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">not linked</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!m.person && (
                      <Button size="sm" variant="outline" onClick={() => onLink(m.ref)}>
                        <Link2 /> Link
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
