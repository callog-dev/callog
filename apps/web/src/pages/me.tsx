import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CircleDashed, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ProviderBadge } from "@/components/provider-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { api, type DmChannel, type Identity, type Me } from "@/lib/api";

const display = (i: Identity) =>
  i.provider === "telegram" && i.handle ? `@${i.handle}` : (i.handle ?? i.externalId);

export function MePage({ me }: { me: Me }) {
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
              <p className="text-sm text-muted-foreground">
                Link more in Slack:{" "}
                {missing.map((p) => (
                  <code key={p} className="mr-1 rounded bg-muted px-1">
                    /notify link {p}
                  </code>
                ))}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Personal copies</CardTitle>
          <CardDescription>
            Routes with personal copies also message you directly. Choose where they arrive; mute
            single routes on the Routes page.
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
          <div className="text-sm">
            <span className="text-muted-foreground">Muted: </span>
            {me.preferences.mutedRoutes.length === 0
              ? "nothing"
              : me.preferences.mutedRoutes.map((r) => (
                  <code key={r} className="mr-1 rounded bg-muted px-1">
                    {r}
                  </code>
                ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
