import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Me } from "@/lib/api";
import { AdminsTab } from "./admins";
import { ApiKeysTab } from "./api-keys";
import { DeliveriesTab } from "./deliveries";
import { GettingStarted } from "./getting-started";
import { OverviewTab } from "./overview";
import { PeopleTab } from "./people";
import { SettingsTab } from "./settings";
import { TeamsTab } from "./teams";

export function AdminPage({ me }: { me: Me }) {
  return (
    <div className="space-y-4">
      <GettingStarted />
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
          <TabsTrigger value="api-keys">API keys</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesTab />
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab />
        </TabsContent>
        <TabsContent value="teams">
          <TeamsTab />
        </TabsContent>
        <TabsContent value="admins">
          <AdminsTab me={me} />
        </TabsContent>
        <TabsContent value="api-keys">
          <ApiKeysTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
