import type { IconName } from "./icon";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/leads", label: "Leads", icon: "leads" },
  { href: "/contacts", label: "Contacts", icon: "contacts" },
  { href: "/appointments", label: "Appointments", icon: "appointments" },
  { href: "/conversations", label: "Conversations", icon: "conversations" },
  { href: "/estimates", label: "Estimates", icon: "estimates" },
  { href: "/jobs", label: "Jobs", icon: "jobs" },
  { href: "/activity", label: "Activity", icon: "activity" },
  { href: "/settings", label: "Settings", icon: "settings" },
];
