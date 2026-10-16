import { BellRing } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BellRing className="size-5" />
          </div>
          <CardTitle className="text-xl">Callog</CardTitle>
          <CardDescription>
            Engineering notifications, routed from your config repo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full" size="lg">
            <a href="/auth/github/login">
              <GithubIcon /> Sign in with GitHub
            </a>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Not linked yet? Run <code className="rounded bg-muted px-1">/notify link github</code>{" "}
            in Slack first.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
