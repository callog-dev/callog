import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { ISSUE_LEVEL_TEXT } from "@/components/config-issues";
import { DataTable, type ColumnDef } from "@/components/data-table";
import { ProviderBadge } from "@/components/provider-badge";
import { RouteLink } from "@/components/route-parts";
import { EmptyState, ErrorState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, type PlaceInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Places from places.yaml: the room behind each name, and what uses it. Read-only. */
export function PlacesTab() {
  const places = useQuery({ queryKey: ["admin", "places"], queryFn: adminApi.places });

  if (places.isPending) return <Skeleton className="h-64 w-full" />;
  if (places.isError) {
    return <ErrorState error={places.error} retry={() => void places.refetch()} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Places</CardTitle>
        <CardDescription>
          Rooms by name. Routes deliver to <code>place: name</code> and senders add{" "}
          <code>place:name</code> to recipients; only <code>places.yaml</code> in the config repo
          says which room that is.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={COLUMNS}
          data={places.data}
          getRowId={(place) => place.name}
          empty={
            <EmptyState icon={MapPin} title="No places yet">
              Places come from <code>places.yaml</code> in the config repo.
            </EmptyState>
          }
        />
      </CardContent>
    </Card>
  );
}

const COLUMNS: ColumnDef<PlaceInfo>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <span className="font-medium">
        <MapPin className="mr-1 inline size-3.5" />
        {row.original.name}
      </span>
    ),
  },
  {
    accessorKey: "room",
    header: "Room",
    cell: ({ row: { original: place } }) => (
      <>
        <ProviderBadge provider={place.channel}>{place.room}</ProviderBadge>
        {place.issue && (
          <p className={cn("mt-1 text-xs", ISSUE_LEVEL_TEXT[place.issue.level])}>
            {place.issue.message}
          </p>
        )}
      </>
    ),
  },
  {
    id: "routes",
    header: "Used by",
    enableSorting: false,
    cell: ({ row }) => {
      const { routes, defaultFor } = row.original;
      if (routes.length + defaultFor.length === 0) {
        return <span className="text-muted-foreground">no route — senders can still name it</span>;
      }
      return (
        <div className="flex flex-wrap gap-x-3">
          {routes.map((id) => (
            <RouteLink key={id} id={id} />
          ))}
          {defaultFor.map((id) => (
            <span key={id}>
              <RouteLink id={id} /> <span className="text-muted-foreground">(by default)</span>
            </span>
          ))}
        </div>
      );
    },
  },
];
