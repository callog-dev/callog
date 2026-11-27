import { Link } from "react-router";
import { GitBranch, KeyRound } from "lucide-react";
import { ProviderBadge } from "@/components/provider-badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RouteSummary } from "@/lib/api";
import { useMuteToggle } from "@/lib/mutes";

/**
 * Where a route posts; a Telegram chat shows its title, with the id on hover. A fallback is
 * where a notification goes only when it reaches nobody else.
 */
export function RouteDestinations({ route }: { route: RouteSummary }) {
  return route.destinations.map((d) => (
    <span key={`${d.provider}${d.destination}`} className="inline-flex items-center gap-1">
      <DestinationBadge {...d} />
      {d.fallback && <span className="text-muted-foreground">when it reaches nobody else</span>}
    </span>
  ));
}

/** A room by its name; one known only by an id shows its title, with the id on hover. */
export function DestinationBadge({
  provider,
  destination,
  label,
}: Pick<RouteSummary["destinations"][number], "provider" | "destination" | "label">) {
  return (
    <ProviderBadge provider={provider} title={label ? destination : undefined}>
      {label ?? destination}
    </ProviderBadge>
  );
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
      {route.allowedSources.github_repos.length + route.allowedSources.api_keys.length === 0 && (
        <span className="text-muted-foreground">hooks only</span>
      )}
    </>
  );
}

/** A route on or off for the person: muted, it sends them no copy and does not mention them. */
export function MuteSwitch({ route, linked }: { route: RouteSummary; linked: boolean }) {
  const toggle = useMuteToggle();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Switch
            checked={route.mandatory || !route.muted}
            disabled={!linked || route.mandatory}
            onCheckedChange={(on) => toggle.mutate({ routeId: route.id, muted: !on })}
            aria-label={`Personal copies of ${route.id}`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {route.mandatory
          ? "A mandatory route: it cannot be muted"
          : linked
            ? "Muted, it sends you no copy and does not mention you"
            : "Link your GitHub account to manage personal copies"}
      </TooltipContent>
    </Tooltip>
  );
}

/** A route by its id, linking to its page. */
export function RouteLink({ id }: { id: string }) {
  return (
    <Link className="underline-offset-4 hover:underline" to={`/routes/${encodeURIComponent(id)}`}>
      {id}
    </Link>
  );
}
