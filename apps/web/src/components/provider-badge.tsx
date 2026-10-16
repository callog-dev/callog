import { Hash, Mail, Send } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { Badge } from "@/components/ui/badge";
import type { Provider } from "@/lib/api";

const ICONS = { slack: Hash, github: GithubIcon, telegram: Send, email: Mail } as const;
const LABELS = { slack: "Slack", github: "GitHub", telegram: "Telegram", email: "Email" } as const;

export function ProviderBadge({
  provider,
  children,
  title,
}: {
  provider: Provider;
  children?: React.ReactNode;
  /** Native tooltip, e.g. the raw id behind a human-readable label. */
  title?: string;
}) {
  const Icon = ICONS[provider];
  return (
    <Badge variant="secondary" className="gap-1 font-normal" title={title}>
      <Icon className="size-3" />
      {children ?? LABELS[provider]}
    </Badge>
  );
}
