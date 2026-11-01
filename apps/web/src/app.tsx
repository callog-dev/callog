import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette, useCommandPalette } from "@/components/command-palette";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type Me } from "@/lib/api";
import { navItemFor } from "@/lib/nav";
import { AdminRoutes } from "@/pages/admin";
import { LoginPage } from "@/pages/login";
import { MePage } from "@/pages/me";
import { RoutePage } from "@/pages/route";
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
  const current = navItemFor(useLocation().pathname, me.isAdmin);
  const [searching, setSearching] = useCommandPalette();
  return (
    <SidebarProvider>
      <AppSidebar me={me} current={current} onSearch={() => setSearching(true)} />
      <CommandPalette me={me} open={searching} onOpenChange={setSearching} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <h1 className="text-sm font-medium">{current?.title}</h1>
        </header>
        <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
          <Routes>
            <Route path="/routes" element={<RoutesPage linked={me.person !== null} />} />
            <Route
              path="/routes/:routeId"
              element={<RoutePage linked={me.person !== null} admin={me.isAdmin} />}
            />
            <Route path="/me" element={<MePage me={me} />} />
            {me.isAdmin && <Route path="/manage/*" element={<AdminRoutes me={me} />} />}
            <Route
              path="*"
              element={<Navigate to={me.person || !me.isAdmin ? "/routes" : "/manage"} replace />}
            />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
