import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Hash, RefreshCw, Send } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { GithubIcon } from "@/components/github-icon";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi, type AdminStatus } from "@/lib/api";
import { ago } from "@/lib/time";
import {
  SlackConnectDialog,
  TelegramChats,
  TelegramConnectDialog,
  useChannelsChanged,
} from "./connect-channels";

export function IntegrationsPage() {
  const status = useQuery({ queryKey: ["admin", "status"], queryFn: adminApi.status });
  if (status.isPending) return <Skeleton className="h-96 w-full" />;
  if (status.isError) {
    return <ErrorState error={status.error} retry={() => void status.refetch()} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <GithubCard status={status.data} />
      <SlackCard slack={status.data.slack} />
      <TelegramCard telegram={status.data.telegram} />
    </div>
  );
}

function IntegrationCard({
  icon,
  title,
  connected,
  description,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** Undefined for what cannot be disconnected (the GitHub App this UI runs on). */
  connected?: boolean;
  description: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
          {connected !== undefined && (
            <Badge variant={connected ? "secondary" : "outline"}>
              {connected ? "connected" : "not connected"}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {children}
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </CardContent>
    </Card>
  );
}

function GithubCard({ status }: { status: AdminStatus }) {
  const latest = status.config.latest;
  const installation =
    status.installationId &&
    `https://github.com/organizations/${status.org}/settings/installations/${status.installationId}`;
  return (
    <IntegrationCard
      icon={<GithubIcon className="size-4" />}
      title="GitHub"
      description={`The Callog GitHub App is installed on ${status.org}.`}
      actions={
        installation && (
          <Button size="sm" variant="outline" asChild>
            <a href={installation} target="_blank" rel="noreferrer">
              <ExternalLink /> Installation settings
            </a>
          </Button>
        )
      }
    >
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        <dt className="text-muted-foreground">Config repo</dt>
        <dd>
          <a
            className="underline-offset-4 hover:underline"
            href={`https://github.com/${status.configRepo}`}
            target="_blank"
            rel="noreferrer"
          >
            {status.configRepo}
          </a>
        </dd>
        <dt className="text-muted-foreground">Last push</dt>
        <dd>
          {latest ? (
            <>
              <code>{latest.commitSha.slice(0, 7)}</code> · {ago(latest.createdAt)}
              {latest.status === "invalid" && (
                <Badge variant="destructive" className="ml-2">
                  rejected
                </Badge>
              )}
            </>
          ) : (
            "none yet"
          )}
        </dd>
      </dl>
    </IntegrationCard>
  );
}

function SlackCard({ slack }: { slack: AdminStatus["slack"] }) {
  const [connecting, setConnecting] = useState(false);
  const sync = useMutation({
    mutationFn: adminApi.syncSlack,
    onSuccess: () => toast.success("Importing people from Slack"),
    onError: (e) => toast.error(e.message),
  });
  return (
    <IntegrationCard
      icon={<Hash className="size-4" />}
      title="Slack"
      connected={slack !== null}
      description={
        slack
          ? `Posting to ${slack.team}${slack.commands ? "; /notify answers over Socket Mode" : ""}.`
          : "Channels, mentions and direct messages, plus the /notify command."
      }
      actions={
        slack ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              <RefreshCw className={sync.isPending ? "animate-spin" : ""} /> Sync people
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
              Replace tokens
            </Button>
            <DisconnectButton
              title={`Disconnect ${slack.team}?`}
              description="Notifications to Slack fail until it is connected again. People and their linked accounts stay."
              disconnect={adminApi.disconnectSlack}
              done="Slack disconnected"
            />
          </>
        ) : (
          <Button size="sm" onClick={() => setConnecting(true)}>
            Connect Slack
          </Button>
        )
      }
    >
      {slack && (
        <>
          <p className="text-muted-foreground">
            {slack.lastSyncedAt
              ? `People synced ${ago(slack.lastSyncedAt)}.`
              : "People not synced yet."}
          </p>
          <SlackTestMessage />
        </>
      )}
      {connecting && <SlackConnectDialog onClose={() => setConnecting(false)} />}
    </IntegrationCard>
  );
}

function TelegramCard({ telegram }: { telegram: AdminStatus["telegram"] }) {
  const [connecting, setConnecting] = useState(false);
  const test = useMutation({
    mutationFn: adminApi.telegramTestMessage,
    onSuccess: () => toast.success("Test message sent"),
    onError: (e) => toast.error(e.message),
  });
  return (
    <IntegrationCard
      icon={<Send className="size-4" />}
      title="Telegram"
      connected={telegram !== null}
      description={
        telegram
          ? `Posting as @${telegram.bot}.`
          : "Optional: groups for routes that post to Telegram, and direct messages."
      }
      actions={
        telegram ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
              Add to groups or replace
            </Button>
            <DisconnectButton
              title={`Disconnect @${telegram.bot}?`}
              description="Notifications to Telegram fail until a bot is connected again, and the list of its groups is forgotten."
              disconnect={adminApi.disconnectTelegram}
              done="Telegram disconnected"
              forget={["admin", "telegram-chats"]}
            />
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConnecting(true)}>
            Connect Telegram
          </Button>
        )
      }
    >
      {telegram && (
        <TelegramChats
          action={(chatId) => (
            <Button
              size="sm"
              variant="ghost"
              disabled={test.isPending}
              onClick={() => test.mutate(chatId)}
            >
              Send test
            </Button>
          )}
        />
      )}
      {connecting && (
        <TelegramConnectDialog bot={telegram?.bot ?? null} onClose={() => setConnecting(false)} />
      )}
    </IntegrationCard>
  );
}

function DisconnectButton({
  title,
  description,
  disconnect,
  done,
  forget,
}: {
  title: string;
  description: string;
  disconnect: () => Promise<void>;
  done: string;
  /** Queries that only made sense while connected. */
  forget?: string[];
}) {
  const confirm = useConfirm();
  const client = useQueryClient();
  const changed = useChannelsChanged();
  const mutation = useMutation({
    mutationFn: disconnect,
    onSuccess: () => {
      toast.success(done);
      if (forget) client.removeQueries({ queryKey: forget });
      changed();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive"
      disabled={mutation.isPending}
      onClick={async () => {
        if (await confirm({ title, description, action: "Disconnect", destructive: true })) {
          mutation.mutate();
        }
      }}
    >
      Disconnect
    </Button>
  );
}

function SlackTestMessage() {
  const [channel, setChannel] = useState("");
  const test = useMutation({
    mutationFn: () => adminApi.slackTestMessage(channel.trim()),
    onSuccess: () => toast.success("Test message sent"),
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    test.mutate();
  };
  return (
    <form className="flex gap-2" onSubmit={submit}>
      <Input
        aria-label="Channel for a test message"
        placeholder="#general"
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        className="max-w-48"
      />
      <Button
        size="sm"
        variant="outline"
        type="submit"
        disabled={!channel.trim() || test.isPending}
      >
        Send test
      </Button>
    </form>
  );
}
