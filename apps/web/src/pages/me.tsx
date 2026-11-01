import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CircleDashed, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ProviderBadge } from "@/components/provider-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { api, type DmChannel, type Identity, type LinkedMe, type Me } from "@/lib/api";
import { useMuteToggle } from "@/lib/mutes";

const display = (i: Identity) =>
  i.provider === "telegram" && i.handle ? `@${i.handle}` : (i.handle ?? i.externalId);

const LINK_HINTS = {
  github: "Link GitHub so workflows can mention you.",
  telegram: "Link Telegram to get personal copies there and be mentioned in Telegram groups.",
};

export function MePage({ me }: { me: Me }) {
  return me.person ? <PersonPage me={me} /> : <UnlinkedPage me={me} />;
}

function UnlinkedPage({ me }: { me: Me }) {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>@{me.githubLogin}</CardTitle>
        <CardDescription>
          You are signed in as an owner of {me.org}, but your GitHub account is not linked to you in
          Slack yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        Run <code className="rounded bg-muted px-1">/notify link github</code> in Slack, confirm the
        link and sign in again: notifications will mention you, and you can choose where personal
        copies arrive.
      </CardContent>
    </Card>
  );
}

function PersonPage({ me }: { me: LinkedMe }) {
  const client = useQueryClient();
  const hasTelegram = me.identities.some(
    (i) => i.provider === "telegram" && i.confidence !== "suggested",
  );
  const setDm = useMutation({
    mutationFn: (channel: DmChannel) => api.setDmChannel(channel),
    onSuccess: (_, channel) => {
      toast.success(`Personal copies will go to ${channel === "slack" ? "Slack" : "Telegram"}`);
      void client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => toast.error(err.message),
  });
  const missing = (["github", "telegram"] as const).filter(
    (p) => !me.identities.some((i) => i.provider === p),
  );

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {me.person.name}
            {me.isAdmin && (
              <Badge className="gap-1">
                <ShieldCheck className="size-3" />
                admin
              </Badge>
            )}
          </CardTitle>
          <CardDescription>Accounts Callog knows are yours in {me.org}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.identities.map((i) => (
            <div
              key={`${i.provider}${i.externalId}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <ProviderBadge provider={i.provider} />
                <span className="truncate text-sm">{display(i)}</span>
              </div>
              <span
                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                title={`via ${i.source}`}
              >
                {i.confidence === "suggested" ? (
                  <CircleDashed className="size-3.5" />
                ) : (
                  <BadgeCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                )}
                {i.confidence}
              </span>
            </div>
          ))}
          {missing.length > 0 && (
            <>
              <Separator />
              <ul className="space-y-2 text-sm text-muted-foreground">
                {missing.map((p) => (
                  <li key={p}>
                    {LINK_HINTS[p]} Run{" "}
                    <code className="rounded bg-muted px-1 text-foreground">/notify link {p}</code>{" "}
                    in Slack.
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personal copies</CardTitle>
          <CardDescription>
            Routes with personal copies also message you directly. Choose where they arrive and
            which routes stay quiet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={me.preferences.dmChannel}
            onValueChange={(v) => setDm.mutate(v as DmChannel)}
            disabled={setDm.isPending}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="slack" id="dm-slack" />
              <Label htmlFor="dm-slack">Slack direct message</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="telegram" id="dm-telegram" disabled={!hasTelegram} />
              <Label htmlFor="dm-telegram" className={hasTelegram ? "" : "text-muted-foreground"}>
                Telegram {hasTelegram ? "" : "(link Telegram first)"}
              </Label>
            </div>
          </RadioGroup>
          <Separator />
          <MutedRoutes routes={me.preferences.mutedRoutes} />
        </CardContent>
      </Card>
    </div>
  );
}

function MutedRoutes({ routes }: { routes: string[] }) {
  const toggle = useMuteToggle();
  if (routes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No route is muted. Mute one on its page under{" "}
        <Link to="/routes" className="underline underline-offset-4">
          Routes
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="text-muted-foreground">Muted routes</div>
      <ul className="divide-y rounded-md border">
        {routes.map((routeId) => (
          <li key={routeId} className="flex items-center justify-between gap-2 px-3 py-2">
            <Link
              to={`/routes/${encodeURIComponent(routeId)}`}
              className="truncate font-medium underline-offset-4 hover:underline"
            >
              {routeId}
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => toggle.mutate({ routeId, muted: false })}
            >
              Unmute
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
