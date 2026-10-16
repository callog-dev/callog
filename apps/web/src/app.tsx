import { useMutation, useQuery } from "@tanstack/react-query";
import { BellRing, LogOut, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type Me } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AdminPage } from "@/pages/admin";
import { LoginPage } from "@/pages/login";
import { MePage } from "@/pages/me";
import { RoutesPage } from "@/pages/routes";

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (me.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
    return <p className="p-6 text-destructive">Could not reach the server: {me.error.message}</p>;
  }
  return <Shell me={me.data} />;
}

function Shell({ me }: { me: Me }) {
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.assign("/"),
  });
  const { resolvedTheme, setTheme } = useTheme();
  const initials = me.person.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      isActive
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="min-h-svh bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <div className="flex items-center gap-2 font-semibold">
            <BellRing className="size-4" /> Callog
            <span className="font-normal text-muted-foreground">/ {me.org}</span>
          </div>
          <nav className="flex gap-1">
            <NavLink to="/routes" className={link}>
              Routes
            </NavLink>
            <NavLink to="/me" className={link}>
              Me
            </NavLink>
            {me.isAdmin && (
              <NavLink to="/manage" className={link}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
                  <Avatar className="size-8">
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{me.person.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => logout.mutate()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">
        <Routes>
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/me" element={<MePage me={me} />} />
          {me.isAdmin && <Route path="/manage" element={<AdminPage me={me} />} />}
          <Route path="*" element={<Navigate to="/routes" replace />} />
        </Routes>
      </main>
    </div>
  );
}
