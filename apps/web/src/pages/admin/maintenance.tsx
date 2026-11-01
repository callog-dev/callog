import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi } from "@/lib/api";
import { ago } from "@/lib/time";

/** Tasks that otherwise run on a schedule, for this workspace only. */
export function MaintenancePage() {
  const status = useQuery({ queryKey: ["admin", "maintenance"], queryFn: adminApi.maintenance });
  const client = useQueryClient();
  const confirm = useConfirm();
  const refresh = () => void client.invalidateQueries({ queryKey: ["admin", "maintenance"] });
  const sync = useMutation({
    mutationFn: adminApi.syncPeople,
    onSuccess: () => {
      toast.success("Syncing people");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const retention = useMutation({
    mutationFn: adminApi.runRetention,
    onSuccess: (r) => {
      toast.success(
        `Deleted ${r.notifications} notifications and ${r.configVersions} config versions`,
      );
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  if (status.isPending) return <Skeleton className="h-48 w-full" />;
  if (status.isError)
    return <ErrorState error={status.error} retry={() => void status.refetch()} />;
  const { sync: lastSync, retention: lastRetention } = status.data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Task
        title="Sync people"
        description="Imports people from Slack and matches their GitHub accounts. Runs every hour."
        last={lastSync && `Last run here ${ago(lastSync.at)}.`}
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={sync.isPending ? "animate-spin" : ""} /> Sync now
          </Button>
        }
      />
      <Task
        title="Apply retention"
        description="Deletes notifications, unused config versions and unmapped recipients older than retention_days in config.yaml (30 days by default). Runs every night."
        last={
          lastRetention &&
          `Last run here ${ago(lastRetention.at)}: ${lastRetention.details.notifications} notifications, ${lastRetention.details.configVersions} config versions, ${lastRetention.details.unmappedRecipients} unmapped recipients deleted.`
        }
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={retention.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: "Delete data past retention now?",
                description: "What is older than retention_days is deleted for good.",
                action: "Delete",
                destructive: true,
              });
              if (ok) retention.mutate();
            }}
          >
            <Trash2 /> Apply now
          </Button>
        }
      />
    </div>
  );
}

function Task({
  title,
  description,
  last,
  action,
}: {
  title: string;
  description: string;
  last: string | null;
  action: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{last ?? "Not run from here yet."}</p>
        {action}
      </CardContent>
    </Card>
  );
}
