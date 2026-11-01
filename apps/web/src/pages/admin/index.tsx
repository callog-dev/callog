import { Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Me } from "@/lib/api";
import { AdminsTab } from "./admins";
import { ApiKeysTab } from "./api-keys";
import { DeliveriesTab } from "./deliveries";
import { GettingStarted } from "./getting-started";
import { OverviewTab } from "./overview";
import { PeopleTab } from "./people";
import { SettingsTab } from "./settings";
import { TeamsTab } from "./teams";

/** Everything under `/manage`; unknown paths fall back to the overview. */
export function AdminRoutes({ me }: { me: Me }) {
  return (
    <Routes>
      <Route
        index
        element={
          <div className="space-y-4">
            <GettingStarted />
            <OverviewTab />
          </div>
        }
      />
      <Route path="deliveries/:id?" element={<DeliveriesTab />} />
      <Route path="people" element={<PeopleTab />} />
      <Route path="teams" element={<TeamsTab />} />
      <Route path="settings" element={<SettingsLayout />}>
        <Route index element={<SettingsTab />} />
        <Route path="admins" element={<AdminsTab me={me} />} />
        <Route path="api-keys" element={<ApiKeysTab />} />
      </Route>
      <Route path="*" element={<Navigate to="/manage" replace />} />
    </Routes>
  );
}

const SETTINGS = [
  { title: "General", url: "/manage/settings" },
  { title: "Admins", url: "/manage/settings/admins" },
  { title: "API keys", url: "/manage/settings/api-keys" },
];

function SettingsLayout() {
  const { pathname } = useLocation();
  return (
    <div className="space-y-4">
      <Tabs value={pathname}>
        <TabsList variant="line">
          {SETTINGS.map((item) => (
            <TabsTrigger key={item.url} value={item.url} asChild>
              <Link to={item.url}>{item.title}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
