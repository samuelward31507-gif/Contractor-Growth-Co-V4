// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "Sparkles"
  | "Users"
  | "Wallet"
  | "MessageSquare"
  | "CalendarClock"
  | "Star"
  | "Workflow"
  | "BarChart3"
  | "Building2"
  | "Settings"
  | "Hammer"
  | "FileText";

import type { OrganizationVertical } from "@/lib/auth/organization";
import { getTerminology } from "@/lib/verticals/terminology";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  /** Omitted = visible to every vertical. Jobs and Estimates (like Money before them) are contractor-specific - everything else is vertical-neutral per the Gym Trackpr audit, unchanged by the Trackpr 2.0 IA work. */
  verticals?: OrganizationVertical[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Nav-restructure pass: un-merges Money back into its own two real
 * destinations - Estimates and Jobs were always genuinely distinct data
 * (never the "same 37 rows twice" problem the original IA consolidation
 * pass fixed for Customers/People or Calendar/Appointments), and a
 * contractor asked for the more granular, GHL-style breadth back:
 * separately browsable Jobs and Estimates tabs rather than one merged
 * Money view behind a tab switcher. Money's own page (app/(app)/money/
 * page.tsx) is untouched and still fully reachable by URL - nothing it
 * could do is lost - it's just no longer linked from navigation, the same
 * "old routes remain, only the nav entry moves" pattern this codebase
 * already uses everywhere else. The one real thing Money's own default tab
 * showed that neither Estimates nor Jobs alone could - the cross-entity
 * "what's in motion financially" snapshot - now lives on Dashboard instead
 * (see lib/money/snapshot.ts and today/page.tsx's own "Money at a glance"
 * section), so nothing behind that view was dropped either.
 *
 * "Today" is relabeled "Dashboard" in this list only - its href, page, and
 * dynamic headline are all unchanged; this is the exact same screen, given
 * back its familiar name as one more of the terms the contractor originally
 * asked to restore, right alongside Jobs and Estimates.
 *
 * Five primary, ungrouped destinations now (Dashboard, People, Jobs,
 * Estimates, Schedule), everything else still folded into one collapsible
 * More group exactly as before.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { href: "/today", label: "Dashboard", icon: "Sparkles" },
      { href: "/people", label: "People", icon: "Users" },
      { href: "/jobs", label: "Jobs", icon: "Hammer", verticals: ["contractor"] },
      { href: "/estimates", label: "Estimates", icon: "FileText", verticals: ["contractor"] },
      { href: "/schedule", label: "Schedule", icon: "CalendarClock" },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/inbox", label: "Inbox", icon: "MessageSquare" },
      { href: "/growth", label: "Reviews & Referrals", icon: "Star" },
      { href: "/automations", label: "Automations", icon: "Workflow" },
      { href: "/insights", label: "Insights", icon: "BarChart3" },
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
