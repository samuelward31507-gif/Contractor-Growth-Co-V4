// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "LayoutDashboard"
  | "Users"
  | "MessageSquare"
  | "CalendarClock"
  | "Briefcase"
  | "TrendingUp"
  | "Star"
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
  /** Omitted = visible to every vertical. Only Estimates & Jobs (the merged /work destination) is contractor-specific today - everything else is vertical-neutral per the Gym Trackpr audit, unchanged by the Trackpr 2.0 IA work. */
  verticals?: OrganizationVertical[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Trackpr 2.0, Phase 1 (navigation/IA): the locked Trackpr 2.0 information
 * architecture (see the Master Product Specification's own Part 1/21) -
 * Dashboard ungrouped, then WORK/GROWTH/INTELLIGENCE/SYSTEM. Every href
 * below points at a Phase 0 canonical route (/customers, /schedule, /work)
 * or a Phase 1 destination (/opportunities, /growth) - never at a legacy
 * route (/leads, /contacts, /calendar, /appointments, /estimates, /jobs),
 * which remain real, unmodified, and reachable only through Phase 0's own
 * redirect layer (next.config.ts), never as a second, competing primary
 * navigation destination for the same concept.
 *
 * Inbox points at /inbox, a page-level redirect to the real, unmodified
 * /conversations experience (see app/(app)/inbox/page.tsx's own header
 * comment for why a redirect, not a thin dispatcher, is the correct fix
 * here - Conversations' nested list+detail layout can't safely receive the
 * same dispatcher pattern Phase 0 used for Customers/Schedule/Work).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" }],
  },
  {
    label: "Work",
    items: [
      { href: "/customers", label: "Customers", icon: "Users" },
      { href: "/inbox", label: "Inbox", icon: "MessageSquare" },
      { href: "/schedule", label: "Schedule", icon: "CalendarClock" },
      { href: "/work", label: "Estimates & Jobs", icon: "Briefcase", verticals: ["contractor"] },
    ],
  },
  {
    label: "Growth",
    items: [
      { href: "/opportunities", label: "Opportunities", icon: "TrendingUp" },
      { href: "/growth", label: "Reviews & Referrals", icon: "Star" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/analytics", label: "Analytics", icon: "BarChart3" },
      { href: "/automations", label: "Automations", icon: "Workflow" },
    ],
  },
  {
    label: "System",
    items: [{ href: "/settings", label: "Settings", icon: "Settings" }],
  },
];

/**
 * Appended conditionally at render time (only for a real, verified agency
 * admin - see sidebar-content.tsx), never unconditionally in NAV_GROUPS - a
 * nav-visible link is not itself an authorization boundary, but it must
 * never imply access a given user does not actually have. Trackpr 2.0,
 * Phase 1: now placed inside the existing SYSTEM group (alongside Settings)
 * rather than appended as its own separate "Agency" group, per the locked
 * IA - its own route (/agency) and label ("Agency Command Center") are
 * completely unchanged; only its grouping moved.
 */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: "Building2" };

/**
 * Gym Foundation Phase 1, Section 6 (unchanged mechanism, retargeted hrefs):
 * filters NAV_GROUPS down to items visible for a given vertical, relabels
 * "Customers" via lib/verticals/terminology.ts, and folds a verified agency
 * admin's AGENCY_NAV_ITEM into the existing SYSTEM group rather than
 * appending a separate one-item group after it. A contractor org matches
 * every current item, so contractor nav is unaffected by this filtering
 * beyond the Trackpr 2.0 relabel/regroup itself.
 */
export function getNavGroupsForVertical(vertical: OrganizationVertical, showAgencyLink: boolean): NavGroup[] {
  const terminology = getTerminology(vertical);

  return NAV_GROUPS.map((group) => {
    let items = group.items
      .filter((item) => !item.verticals || item.verticals.includes(vertical))
      .map((item) => (item.href === "/customers" ? { ...item, label: terminology.contactsLabel } : item));

    if (group.label === "System" && showAgencyLink) {
      items = [...items, AGENCY_NAV_ITEM];
    }

    return { ...group, items };
  }).filter((group) => group.items.length > 0);
}
