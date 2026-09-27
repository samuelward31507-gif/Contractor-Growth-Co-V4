// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "LayoutDashboard"
  | "Sparkles"
  | "Users"
  | "Wallet"
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
  /** Omitted = visible to every vertical. Only Money (the merged /work destination) is contractor-specific today - everything else is vertical-neutral per the Gym Trackpr audit, unchanged by the Trackpr 2.0 IA work. */
  verticals?: OrganizationVertical[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Trackpr 2.0, Phase 5 (nav/IA): the locked Phase 5 information architecture
 * - four primary, ungrouped destinations (Today, People, Money, Schedule),
 * then everything else folded into one collapsible More group, rather than
 * the four WORK/GROWTH/INTELLIGENCE/SYSTEM groups Phase 1 introduced. Every
 * primary href points at a Phase 2-4 destination (/today, /people, /money)
 * or the unchanged /schedule - never at a route this same plan superseded
 * (/dashboard, /customers, /work), which remain real, unmodified, and still
 * reachable (via More, or directly by URL for the Dashboard-vs-Today
 * comparison week the plan calls for), never as a second, competing primary
 * navigation destination for the same concept.
 *
 * Inbox, Opportunities, Reviews & Referrals, Automations ("Auto follow-up"),
 * Analytics ("Numbers"), and Settings all move into More - the plan's own
 * summary only named Automations/Analytics/Settings explicitly, so the
 * other three (plus Dashboard, for the comparison week) join them there
 * rather than disappearing from navigation entirely; nothing that was
 * reachable before Phase 5 becomes unreachable after it.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { href: "/today", label: "Today", icon: "Sparkles" },
      { href: "/people", label: "People", icon: "Users" },
      { href: "/money", label: "Money", icon: "Wallet", verticals: ["contractor"] },
      { href: "/schedule", label: "Schedule", icon: "CalendarClock" },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" },
      { href: "/inbox", label: "Inbox", icon: "MessageSquare" },
      { href: "/opportunities", label: "Opportunities", icon: "TrendingUp" },
      { href: "/growth", label: "Reviews & Referrals", icon: "Star" },
      { href: "/automations", label: "Auto follow-up", icon: "Workflow" },
      { href: "/analytics", label: "Numbers", icon: "BarChart3" },
      { href: "/settings", label: "Settings", icon: "Settings" },
    ],
  },
];

/**
 * Appended conditionally at render time (only for a real, verified agency
 * admin - see sidebar-content.tsx), never unconditionally in NAV_GROUPS - a
 * nav-visible link is not itself an authorization boundary, but it must
 * never imply access a given user does not actually have. Trackpr 2.0,
 * Phase 5: now placed inside the More group (alongside Settings) rather
 * than the old SYSTEM group it used to join - its own route (/agency) and
 * label ("Agency Command Center") are completely unchanged; only its
 * grouping moved.
 */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: "Building2" };

/**
 * Gym Foundation Phase 1, Section 6 (unchanged mechanism, retargeted hrefs):
 * filters NAV_GROUPS down to items visible for a given vertical, relabels
 * "People" via lib/verticals/terminology.ts, and folds a verified agency
 * admin's AGENCY_NAV_ITEM into the existing More group rather than
 * appending a separate one-item group after it. A contractor org matches
 * every current item, so contractor nav is unaffected by this filtering
 * beyond the Trackpr 2.0 relabel/regroup itself.
 */
export function getNavGroupsForVertical(vertical: OrganizationVertical, showAgencyLink: boolean): NavGroup[] {
  const terminology = getTerminology(vertical);

  return NAV_GROUPS.map((group) => {
    let items = group.items
      .filter((item) => !item.verticals || item.verticals.includes(vertical))
      .map((item) => (item.href === "/people" ? { ...item, label: terminology.contactsLabel } : item));

    if (group.label === "More" && showAgencyLink) {
      items = [...items, AGENCY_NAV_ITEM];
    }

    return { ...group, items };
  }).filter((group) => group.items.length > 0);
}
