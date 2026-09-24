// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "LayoutDashboard"
  | "Users"
  | "Contact"
  | "MessageSquare"
  | "CalendarClock"
  | "FileText"
  | "Briefcase"
  | "Workflow"
  | "BarChart3"
  | "Building2"
  | "Settings";

import type { OrganizationVertical } from "@/lib/auth/organization";
import { getTerminology } from "@/lib/verticals/terminology";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  /** Omitted = visible to every vertical. Gym Foundation Phase 1, Section 6: only Estimates/Jobs are contractor-specific today - everything else (Leads, Contacts, Conversations, Appointments, Automations, Analytics, Settings) is vertical-neutral per the Gym Trackpr audit. */
  verticals?: OrganizationVertical[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Trackpr visual-system redesign: four operator-facing groups instead of
 * seven thin ones (Customers/Scheduling/Sales/Automation/Insights/Settings
 * previously) - OPERATE holds everything a contractor touches running the
 * day-to-day business, AUTOMATE and INSIGHTS get their own single-purpose
 * groups since they're conceptually distinct from daily operations, SYSTEM
 * holds account-level configuration. Maps directly onto the real, existing
 * routes - no route was invented or removed for this regroup.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" }],
  },
  {
    label: "Operate",
    items: [
      { href: "/leads", label: "Leads", icon: "Users" },
      { href: "/contacts", label: "Contacts", icon: "Contact" },
      { href: "/conversations", label: "Inbox", icon: "MessageSquare" },
      { href: "/appointments", label: "Appointments", icon: "CalendarClock" },
      { href: "/estimates", label: "Estimates", icon: "FileText", verticals: ["contractor"] },
      { href: "/jobs", label: "Jobs", icon: "Briefcase", verticals: ["contractor"] },
    ],
  },
  {
    label: "Automate",
    items: [{ href: "/automations", label: "Automations", icon: "Workflow" }],
  },
  {
    label: "Grow",
    items: [{ href: "/analytics", label: "Analytics", icon: "BarChart3" }],
  },
  {
    label: "System",
    items: [{ href: "/settings", label: "Settings", icon: "Settings" }],
  },
];

/** Appended conditionally at render time (only for a real, verified agency admin - see sidebar-content.tsx), never unconditionally in NAV_GROUPS - a nav-visible link is not itself an authorization boundary, but it must never imply access a given user does not actually have. */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: "Building2" };

/**
 * Gym Foundation Phase 1, Section 6: filters NAV_GROUPS (plus the Agency
 * group, folded in here rather than in sidebar-content.tsx so this is the
 * single place nav visibility is decided) down to items visible for a given
 * vertical, and relabels "Contacts" via lib/verticals/terminology.ts. A
 * contractor org matches every current item (none is tagged
 * `verticals: ["gym"]` yet), so this produces byte-identical output to the
 * old inline `NAV_GROUPS` / `AGENCY_NAV_ITEM` spread it replaces in
 * sidebar-content.tsx - contractor nav is unchanged. Empty groups (a gym
 * org filtering out every item in "Operate" once Estimates/Jobs are
 * removed) are dropped rather than rendered as a bare, item-less heading.
 */
export function getNavGroupsForVertical(vertical: OrganizationVertical, showAgencyLink: boolean): NavGroup[] {
  const terminology = getTerminology(vertical);
  const groups = showAgencyLink ? [...NAV_GROUPS, { label: "Agency", items: [AGENCY_NAV_ITEM] }] : NAV_GROUPS;

  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => !item.verticals || item.verticals.includes(vertical))
        .map((item) => (item.href === "/contacts" ? { ...item, label: terminology.contactsLabel } : item)),
    }))
    .filter((group) => group.items.length > 0);
}
