import { Navigate, Route, Routes } from "react-router";
import { RouteTabs } from "@/components/route-tabs";
import type { Me } from "@/lib/api";
import { AdminsTab } from "./admins";
import { ApiKeysTab } from "./api-keys";
import { ConfigPage } from "./config";
import { DeliveriesTab } from "./deliveries";
import { GettingStarted } from "./getting-started";
import { IntegrationsPage } from "./integrations";
import { OverviewTab } from "./overview";
import { PeoplePage } from "./people";
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
      <Route path="people/*" element={<PeoplePage />} />
      <Route path="teams" element={<TeamsTab />} />
      <Route path="integrations" element={<IntegrationsPage />} />
      <Route path="config/:versionId?" element={<ConfigPage />} />
      <Route path="settings" element={<RouteTabs tabs={SETTINGS} />}>
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
