import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminApi, type Onboarding } from "@/lib/api";
import { SlackConnectDialog, TelegramConnectDialog } from "./connect-channels";

const README = "https://github.com/callog-dev/callog#self-hosting";

/** Hidden once every required step is done; it reappears if something gets disconnected. */
export function GettingStarted() {
  const onboarding = useQuery({ queryKey: ["admin", "onboarding"], queryFn: adminApi.onboarding });
  const [dialog, setDialog] = useState<"slack" | "telegram">();
  if (!onboarding.data || onboarding.data.complete) return null;
  const { steps } = onboarding.data;
  const done = Object.values(steps).filter((s) => s.done).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Getting started</CardTitle>
        <CardDescription>
          {done} of {Object.keys(steps).length} done. Each step turns green on its own once Callog
          sees it working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {stepList(steps, setDialog).map((step) => (
            <li key={step.title} className="flex gap-3">
              <StepIcon done={step.done} problem={step.problem} />
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  {step.title}
                  {step.optional && <Badge variant="outline">optional</Badge>}
                </div>
                {!step.done && <div className="text-muted-foreground">{step.hint}</div>}
              </div>
              {!step.done && step.action}
            </li>
          ))}
        </ol>
      </CardContent>
      {dialog === "slack" && <SlackConnectDialog onClose={() => setDialog(undefined)} />}
      {dialog === "telegram" && (
        <TelegramConnectDialog bot={steps.telegram.bot} onClose={() => setDialog(undefined)} />
      )}
    </Card>
  );
}

function stepList(steps: Onboarding["steps"], open: (dialog: "slack" | "telegram") => void) {
  const guide = (
    <a className="underline underline-offset-4" href={README} target="_blank" rel="noreferrer">
      see the setup guide
    </a>
  );
  return [
    {
      title: `GitHub App installed on ${steps.githubApp.org}`,
      done: steps.githubApp.done,
      hint: null,
    },
    {
      title: steps.slack.team ? `Slack connected to ${steps.slack.team}` : "Connect Slack",
      done: steps.slack.done,
      hint: "Create Callog's Slack App and paste its two tokens.",
      action: (
        <Button size="sm" onClick={() => open("slack")}>
          Connect
        </Button>
      ),
    },
    {
      title: "Link your GitHub account",
      done: steps.linkGithub.done,
      hint: (
        <>
          Run <code className="rounded bg-muted px-1">/notify link github</code> in Slack and sign
          in again, so notifications can mention you.
        </>
      ),
    },
    {
      title: "Connect Telegram",
      done: steps.telegram.done,
      optional: true,
      hint: "For routes that post to Telegram groups.",
      action: (
        <Button size="sm" variant="outline" onClick={() => open("telegram")}>
          Connect
        </Button>
      ),
    },
    {
      title: `Add the config repo ${steps.config.repo}`,
      done: steps.config.done,
      problem: steps.config.rejected,
      hint: (
        <ConfigRepoHint
          org={steps.githubApp.org}
          installationId={steps.githubApp.installationId}
          {...steps.config}
        />
      ),
      action: <LoadConfigButton />,
    },
    {
      title: "Send a first notification",
      done: steps.firstNotification.done,
      hint: <>From a workflow or with an API key — {guide}.</>,
    },
  ] satisfies Step[];
}

interface Step {
  title: string;
  done: boolean;
  optional?: boolean;
  problem?: boolean;
  hint: ReactNode;
  action?: ReactNode;
}

function StepIcon({ done, problem }: { done: boolean; problem?: boolean }) {
  if (done)
    return (
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
    );
  if (problem) return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />;
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

const TEMPLATE = { owner: "callog-dev", name: "notify-config-template" };

function ConfigRepoHint({
  org,
  repo,
  rejected,
  errors,
  installationId,
}: Onboarding["steps"]["config"] & { org: string; installationId: number | null }) {
  if (rejected) {
    return (
      <>
        The latest push was rejected; the previous version stays active.
        <ul className="mt-1 list-disc pl-4">
          {errors.map((e, i) => (
            <li key={i}>
              <code>{[e.file, e.path.join(".")].filter(Boolean).join(" › ")}</code> — {e.message}
            </li>
          ))}
        </ul>
      </>
    );
  }
  const [owner, name] = repo.split("/");
  const create = new URL("https://github.com/new");
  create.search = new URLSearchParams({
    template_owner: TEMPLATE.owner,
    template_name: TEMPLATE.name,
    owner: owner!,
    name: name!,
    visibility: "private",
  }).toString();
  return (
    <>
      Routes live in this repo.{" "}
      <a
        className="underline underline-offset-4"
        href={create.toString()}
        target="_blank"
        rel="noreferrer"
      >
        Create it from the template
      </a>
      , then load it. Callog also loads every push to its default branch.
      {installationId && (
        <>
          {" "}
          If the GitHub App can see selected repositories only,{" "}
          <a
            className="underline underline-offset-4"
            href={`https://github.com/organizations/${org}/settings/installations/${installationId}`}
            target="_blank"
            rel="noreferrer"
          >
            add {name} to it
          </a>
          .
        </>
      )}
    </>
  );
}

function LoadConfigButton() {
  const client = useQueryClient();
  const load = useMutation({
    mutationFn: adminApi.reloadConfig,
    onSuccess: (r) => {
      if (r.status === "skipped") toast.error(`Not loaded: ${r.reason}`);
      else if (r.status === "invalid") toast.error("The config has errors");
      else toast.success("Config loaded");
      void client.invalidateQueries({ queryKey: ["admin"] });
      void client.invalidateQueries({ queryKey: ["routes"] });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button size="sm" variant="outline" disabled={load.isPending} onClick={() => load.mutate()}>
      <RefreshCw className={load.isPending ? "animate-spin" : ""} /> Load now
    </Button>
  );
}
