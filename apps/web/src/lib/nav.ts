import {
  LayoutDashboard,
  Route,
  Send,
  Settings,
  User,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}

export const GENERAL: NavItem[] = [
  { title: "Routes", url: "/routes", icon: Route },
  { title: "My notifications", url: "/me", icon: User },
];

export const WORKSPACE: NavItem[] = [
  { title: "Overview", url: "/manage", icon: LayoutDashboard },
  { title: "Deliveries", url: "/manage/deliveries", icon: Send },
  { title: "People", url: "/manage/people", icon: Users },
  { title: "Teams", url: "/manage/teams", icon: UsersRound },
  { title: "Settings", url: "/manage/settings", icon: Settings },
];

/** The nav item a path belongs to: the longest URL that prefixes it. */
export function navItemFor(pathname: string, isAdmin: boolean): NavItem | undefined {
  return [...GENERAL, ...(isAdmin ? WORKSPACE : [])]
    .filter((item) => pathname === item.url || pathname.startsWith(`${item.url}/`))
    .sort((a, b) => b.url.length - a.url.length)[0];
}
