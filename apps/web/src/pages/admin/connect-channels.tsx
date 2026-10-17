import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminApi } from "@/lib/api";
import manifest from "../../../../../docs/setup/slack-app-manifest.yaml?raw";

const CREATE_SLACK_APP = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifest)}`;
/** While the dialog is open the operator is adding the bot to groups: show them as they come. */
const CHATS_REFRESH_MS = 5_000;

function useChannelsChanged() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["admin", "onboarding"] });
    void client.invalidateQueries({ queryKey: ["admin", "status"] });
  };
}

export function SlackConnectDialog({ onClose }: { onClose: () => void }) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const changed = useChannelsChanged();
  const connect = useMutation({
    mutationFn: () => adminApi.connectSlack(botToken.trim(), appToken.trim()),
    onSuccess: ({ team }) => {
      toast.success(`Connected to ${team}. People are being imported.`);
      changed();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Slack</DialogTitle>
          <DialogDescription>
            Callog posts as its own Slack App and runs /notify over Socket Mode, so no public URL is
            needed.
          </DialogDescription>
        </DialogHeader>
        <form id="slack" className="space-y-4 text-sm" onSubmit={submit}>
          <Step n={1}>
            <Button asChild variant="outline" size="sm">
              <a href={CREATE_SLACK_APP} target="_blank" rel="noreferrer">
                Create the Slack App <ExternalLink />
              </a>
            </Button>
            <p className="mt-1 text-muted-foreground">
              Pick your workspace, create the app and install it to the workspace.
            </p>
          </Step>
          <Step n={2}>
            <Label htmlFor="bot-token">Bot token</Label>
            <p className="mb-1 text-muted-foreground">
              OAuth &amp; Permissions → Bot User OAuth Token.
            </p>
            <Input
              id="bot-token"
              required
              autoComplete="off"
              placeholder="xoxb-…"
              pattern="xoxb-.+"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </Step>
          <Step n={3}>
            <Label htmlFor="app-token">App-level token</Label>
            <p className="mb-1 text-muted-foreground">
              Basic Information → App-Level Tokens → Generate, with the{" "}
              <code>connections:write</code> scope.
            </p>
            <Input
              id="app-token"
              required
              autoComplete="off"
              placeholder="xapp-…"
              pattern="xapp-.+"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
            />
          </Step>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="slack" disabled={connect.isPending}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TelegramConnectDialog({
  bot,
  onClose,
}: {
  /** The connected bot's username, if any. */
  bot: string | null;
  onClose: () => void;
}) {
  const [botToken, setBotToken] = useState("");
  const [connected, setConnected] = useState(bot);
  const changed = useChannelsChanged();
  const connect = useMutation({
    mutationFn: () => adminApi.connectTelegram(botToken.trim()),
    onSuccess: ({ bot }) => {
      toast.success(`Connected @${bot}`);
      setConnected(bot);
      setBotToken("");
      changed();
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{connected ? `Telegram: @${connected}` : "Connect Telegram"}</DialogTitle>
          <DialogDescription>
            Routes can post to Telegram groups and channels through your own bot.
          </DialogDescription>
        </DialogHeader>
        <form id="telegram" className="space-y-4 text-sm" onSubmit={submit}>
          <Step n={1}>
            <Label htmlFor="telegram-token">Bot token</Label>
            <p className="mb-1 text-muted-foreground">
              Send <code>/newbot</code> to{" "}
              <a
                className="underline"
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
              >
                @BotFather
              </a>{" "}
              and paste the token it gives you{connected ? " to switch to another bot" : ""}.
            </p>
            <div className="flex gap-2">
              <Input
                id="telegram-token"
                required
                autoComplete="off"
                placeholder="123456789:AA…"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
              <Button type="submit" disabled={connect.isPending}>
                {connected ? "Replace" : "Connect"}
              </Button>
            </div>
          </Step>
          {connected && (
            <Step n={2}>
              <p>
                Add @{connected} to a group or channel. It appears below; use its id as a
                destination in a route.
              </p>
              <TelegramChats />
            </Step>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramChats() {
  const chats = useQuery({
    queryKey: ["admin", "telegram-chats"],
    queryFn: adminApi.telegramChats,
    refetchInterval: CHATS_REFRESH_MS,
  });
  if (!chats.data?.length) {
    return <p className="mt-2 text-muted-foreground">No groups yet.</p>;
  }
  return (
    <ul className="mt-2 divide-y rounded-md border">
      {chats.data.map((c) => {
        const line = `telegram: "${c.chatId}"`;
        return (
          <li key={c.chatId} className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{c.title ?? c.chatId}</div>
              <code className="text-xs text-muted-foreground">{line}</code>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Copy ${line}`}
              onClick={() =>
                navigator.clipboard.writeText(line).then(() => toast.success("Copied"))
              }
            >
              <Copy />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
