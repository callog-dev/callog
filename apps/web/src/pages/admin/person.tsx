import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Link2, ShieldCheck, UserRound, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { PersonName } from "@/components/person-name";
import { ProviderBadge } from "@/components/provider-badge";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, ApiError, type AdminIdentity } from "@/lib/api";
import { ago } from "@/lib/time";
import { LinkDialog, useIdentityActions, usePeopleChanged } from "./link-dialog";

export function PersonPage() {
  const { personId } = useParams();
  const person = useQuery({
    queryKey: ["admin", "person", personId],
    queryFn: () => adminApi.person(personId!),
    retry: false,
  });
  const [linking, setLinking] = useState(false);
  const confirm = useConfirm();
  const changed = usePeopleChanged();
  const done = (message: string) => () => (toast.success(message), changed());
  const onError = (e: Error) => toast.error(e.message);
  const identity = useIdentityActions();
  const grant = useMutation({
    mutationFn: adminApi.grantAdmin,
    onSuccess: done("Admin role granted"),
    onError,
  });
  const revoke = useMutation({
    mutationFn: adminApi.revokeAdmin,
    onSuccess: done("Admin role revoked"),
    onError,
  });

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      <Link to="/manage/people">
        <ArrowLeft /> People
      </Link>
    </Button>
  );
  if (person.isPending) return <Skeleton className="h-64 w-full" />;
  if (person.isError) {
    return (
      <div className="space-y-2">
        {back}
        {person.error instanceof ApiError && person.error.status === 404 ? (
          <EmptyState icon={UserRound} title="No such person" />
        ) : (
          <ErrorState error={person.error} retry={() => void person.refetch()} />
        )}
      </div>
    );
  }
  const p = person.data;
  const askUnlink = async (i: AdminIdentity) => {
    const ok = await confirm({
      title: `Unlink ${i.handle ?? i.externalId} from ${p.name}?`,
      description: "Notifications stop mentioning them through this account.",
      action: "Unlink",
      destructive: true,
    });
    if (ok) identity.unlink(i.id);
  };
  const askRevoke = async () => {
    const ok = await confirm({
      title: `Revoke the admin role from ${p.name}?`,
      action: "Revoke",
      destructive: true,
    });
    if (ok) revoke.mutate(p.id);
  };

  return (
    <div className="space-y-4">
      {back}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PersonName name={p.name} status={p.status} />
              {p.admin && (
                <Badge variant="secondary">
                  <ShieldCheck /> admin
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Personal copies go to {p.preferences.dmChannel === "slack" ? "Slack" : "Telegram"}
              {p.preferences.mutedRoutes.length > 0 &&
                `; muted: ${p.preferences.mutedRoutes.join(", ")}`}
              .
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
              <Link2 /> Link account
            </Button>
            {p.status === "active" &&
              (p.admin ? (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={askRevoke}>
                  Revoke admin
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => grant.mutate(p.id)}>
                  Make admin
                </Button>
              ))}
          </div>
        </CardHeader>
        <CardContent>
          <h3 className="mb-2 text-sm font-medium">Accounts</h3>
          <ul className="divide-y rounded-md border text-sm">
            {p.identities.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderBadge provider={i.provider}>{i.handle ?? i.externalId}</ProviderBadge>
                  <span className="text-xs text-muted-foreground">
                    {i.confidence} · {i.source.replace("_", " ")}
                  </span>
                </span>
                <span className="flex gap-1">
                  {i.confidence === "suggested" && (
                    <Button size="sm" variant="outline" onClick={() => identity.confirm(i.id)}>
                      <Check /> Confirm
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unlink ${i.provider}`}
                    onClick={() => askUnlink(i)}
                  >
                    <X />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest notifications naming {p.name}</CardTitle>
        </CardHeader>
        <CardContent>
          {p.recentNotifications.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {p.recentNotifications.map((n) => (
                <li key={n.id}>
                  <Link
                    to={`/manage/deliveries/${n.id}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/50"
                  >
                    <span className="font-medium">{n.route}</span>
                    <span className="text-xs text-muted-foreground">
                      {n.status.replace("_", " ")} · {ago(n.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
        </CardContent>
      </Card>
      {linking && <LinkDialog initialRef="" personId={p.id} onClose={() => setLinking(false)} />}
    </div>
  );
}
