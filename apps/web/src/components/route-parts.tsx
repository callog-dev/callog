import { GitBranch, KeyRound } from "lucide-react";
import { ProviderBadge } from "@/components/provider-badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RouteSummary } from "@/lib/api";
import { useMuteToggle } from "@/lib/mutes";

/** Where a route posts; a Telegram chat shows its title, with the id on hover. */
export function RouteDestinations({ route }: { route: RouteSummary }) {
  return route.destinations.map((d) => (
    <ProviderBadge
      key={`${d.provider}${d.destination}`}
      provider={d.provider}
      title={d.label ? d.destination : undefined}
    >
      {d.label ?? d.destination}
    </ProviderBadge>
  ));
}

/** The repositories (GitHub Actions) and API keys allowed to send to a route. */
export function RouteSources({ route }: { route: RouteSummary }) {
  return (
    <>
      {route.allowedSources.github_repos.map((repo) => (
        <span key={repo} className="inline-flex items-center gap-1">
          <GitBranch className="size-3" /> {repo}
        </span>
      ))}
      {route.allowedSources.api_keys.map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <KeyRound className="size-3" /> key {k}
        </span>
      ))}
    </>
  );
}

/** Personal copies (DMs) of a route, on or off; mentions in channels are not affected. */
export function MuteSwitch({ route, linked }: { route: RouteSummary; linked: boolean }) {
  const toggle = useMuteToggle();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Switch
            checked={!route.muted}
            disabled={!linked}
            onCheckedChange={(on) => toggle.mutate({ routeId: route.id, muted: !on })}
            aria-label={`Personal copies of ${route.id}`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {linked
          ? "Mentions in channels stay either way"
          : "Link your GitHub account to manage personal copies"}
      </TooltipContent>
    </Tooltip>
  );
}
