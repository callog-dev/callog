import { CircleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** What an empty list means and, when there is one, the next step. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      {Icon && (
        <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A failed request, with a retry. */
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <EmptyState
      icon={CircleAlert}
      title="Could not load this"
      action={
        retry && (
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        )
      }
    >
      {error.message}
    </EmptyState>
  );
}
