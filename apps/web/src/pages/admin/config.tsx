import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FileCode, GitCompare } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router";

import { DataTable, type ColumnDef } from "@/components/data-table";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigIssueList } from "@/components/config-issues";
import { adminApi, type ConfigVersionRow } from "@/lib/api";
import { ago } from "@/lib/time";
import { LoadConfigButton } from "./getting-started";

export function ConfigPage() {
  const { versionId } = useParams();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["admin", "status"], queryFn: adminApi.status });
  const versions = useInfiniteQuery({
    queryKey: ["admin", "config-versions"],
    queryFn: ({ pageParam }) => adminApi.configVersions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = useMemo(() => versions.data?.pages.flatMap((p) => p.items) ?? [], [versions.data]);
  const repo = status.data?.configRepo;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {status.data?.config.active
                ? `${status.data.config.active.routes} routes from ${status.data.config.active.commitSha.slice(0, 7)}`
                : "No valid config yet"}
            </CardTitle>
            <CardDescription>
              Routes and teams live in{" "}
              {repo && (
                <a
                  className="underline-offset-4 hover:underline"
                  href={`https://github.com/${repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repo}
                </a>
              )}
              . Callog loads every push to its default branch; change them with a pull request.
            </CardDescription>
          </div>
          <LoadConfigButton />
        </CardHeader>
      </Card>

      {versions.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : versions.isError ? (
        <ErrorState error={versions.error} retry={() => void versions.refetch()} />
      ) : (
        <DataTable
          columns={COLUMNS}
          data={rows}
          getRowId={(v) => v.id}
          onRowClick={(v) => navigate(`/manage/config/${v.id}`)}
          manual={{
            footer: versions.hasNextPage && (
              <Button
                variant="outline"
                onClick={() => versions.fetchNextPage()}
                disabled={versions.isFetchingNextPage}
              >
                Load older
              </Button>
            ),
          }}
          empty={
            <EmptyState icon={FileCode} title="Nothing loaded yet">
              Push to the config repo, or load it now.
            </EmptyState>
          }
        />
      )}

      <Sheet open={versionId !== undefined} onOpenChange={(o) => !o && navigate("/manage/config")}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {versionId && repo && <VersionDetails id={versionId} repo={repo} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

const COLUMNS: ColumnDef<ConfigVersionRow>[] = [
  {
    accessorKey: "createdAt",
    header: "Loaded",
    meta: { className: "whitespace-nowrap text-muted-foreground" },
    cell: ({ row }) => <span title={row.original.createdAt}>{ago(row.original.createdAt)}</span>,
  },
  {
    accessorKey: "commitSha",
    header: "Commit",
    cell: ({ row }) => <code>{row.original.commitSha.slice(0, 7)}</code>,
  },
  {
    accessorKey: "status",
    header: "Result",
    cell: ({ row: { original: v } }) =>
      v.status === "valid" ? (
        <span className="flex items-center gap-2">
          {v.routes} routes
          {v.active && <Badge variant="secondary">active</Badge>}
        </span>
      ) : (
        <Badge variant="destructive">
          rejected: {v.errors} {v.errors === 1 ? "error" : "errors"}
        </Badge>
      ),
  },
];

function VersionDetails({ id, repo }: { id: string; repo: string }) {
  const version = useQuery({
    queryKey: ["admin", "config-version", id],
    queryFn: () => adminApi.configVersion(id),
  });
  if (version.isError) {
    return <ErrorState error={version.error} retry={() => void version.refetch()} />;
  }
  if (!version.data) return <Skeleton className="m-4 h-64" />;
  const v = version.data;
  const fileUrl = (file: string) => `https://github.com/${repo}/blob/${v.commitSha}/${file}`;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <code>{v.commitSha.slice(0, 7)}</code>
          {v.status === "valid" ? (
            v.active && <Badge variant="secondary">active</Badge>
          ) : (
            <Badge variant="destructive">rejected</Badge>
          )}
        </SheetTitle>
        <SheetDescription>
          Loaded {new Date(v.createdAt).toLocaleString()}
          {v.status === "invalid" && "; the previous valid version stayed active"}.
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-6 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <a
              href={`https://github.com/${repo}/commit/${v.commitSha}`}
              target="_blank"
              rel="noreferrer"
            >
              Commit
            </a>
          </Button>
          {v.previousCommitSha && v.previousCommitSha !== v.commitSha && (
            <Button size="sm" variant="outline" asChild>
              <a
                href={`https://github.com/${repo}/compare/${v.previousCommitSha}...${v.commitSha}`}
                target="_blank"
                rel="noreferrer"
              >
                <GitCompare /> Changes since the previous push
              </a>
            </Button>
          )}
        </div>
        {v.errors.length > 0 && (
          <section>
            <h3 className="font-medium text-destructive">Errors</h3>
            <ConfigIssueList issues={v.errors} fileUrl={fileUrl} />
          </section>
        )}
        {v.warnings.length > 0 && (
          <section>
            <h3 className="font-medium">Warnings</h3>
            <ConfigIssueList issues={v.warnings} fileUrl={fileUrl} />
          </section>
        )}
        {v.routes.length > 0 && (
          <section>
            <h3 className="mb-2 font-medium">Routes</h3>
            <div className="flex flex-wrap gap-1">
              {v.routes.map((r) => (
                <code key={r} className="rounded bg-muted px-1">
                  {r}
                </code>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
