import { Link, Outlet, useLocation } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Tabs that are links: each tab is a URL, its page renders below in the `Outlet`. */
export function RouteTabs({ tabs }: { tabs: { url: string; title: string; count?: number }[] }) {
  const { pathname } = useLocation();
  return (
    <div className="space-y-4">
      <Tabs value={pathname}>
        <TabsList variant="line">
          {tabs.map((t) => (
            <TabsTrigger key={t.url} value={t.url} asChild>
              <Link to={t.url}>
                {t.title}
                {t.count ? <Badge variant="secondary">{t.count}</Badge> : null}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
