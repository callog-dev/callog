import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { adminApi } from "@/lib/api";

export function SettingsTab() {
  const status = useQuery({ queryKey: ["admin", "status"], queryFn: adminApi.status });
  if (status.isPending) return <Skeleton className="h-40 w-full" />;
  if (status.isError) return <p className="text-destructive">{status.error.message}</p>;
  const s = status.data;
  const link = (href: string, text: string) => (
    <a className="underline-offset-4 hover:underline" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>This Callog workspace and where its parts live.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 text-sm sm:grid-cols-[12rem_1fr]">
          <Row label="Tenant ID" hint="For the operator API: /admin/tenants/<id>/…">
            <code>{s.tenantId}</code>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Copy the tenant ID"
              onClick={() =>
                navigator.clipboard.writeText(s.tenantId).then(() => toast.success("Copied"))
              }
            >
              <Copy />
            </Button>
          </Row>
          <Row label="GitHub organization">
            {s.installationId
              ? link(
                  `https://github.com/organizations/${s.org}/settings/installations/${s.installationId}`,
                  s.org,
                )
              : s.org}
          </Row>
          <Row label="Config repo">{link(`https://github.com/${s.configRepo}`, s.configRepo)}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <>
      <dt>
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </dt>
      <dd className="flex min-w-0 items-center gap-1">{children}</dd>
    </>
  );
}
