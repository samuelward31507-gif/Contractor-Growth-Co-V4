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
 * IA consolidation pass: the redesign audit found five things wrong with
 * the Phase 5 nav - Dashboard and Today both claiming to be the "what needs
 * you" screen (different counts, same underlying data), Opportunities
 * duplicating Today's own queue under a different visual, Customers and
 * People showing the identical 37 rows, Work and Money reading the same
 * estimates/jobs tables, and three pages (Automations, Analytics, Growth)
 * whose own H1 disagreed with their nav label. This nav is the result of
 * consolidating all five: Dashboard and Opportunities are gone from
 * navigation entirely (both fully absorbed into /today - see its own header
 * comment for exactly what moved), Customers/Leads/Contacts/Work are gone
 * (absorbed into /people and /money respectively), and every remaining
 * item's nav label now matches its own page H1 exactly. Four primary,
 * ungrouped destinations (Today, People, Money, Schedule), everything else
 * folded into one collapsible More group.
 *
 * Every legacy route this consolidation retires (/dashboard, /customers,
 * /leads, /contacts, /work, /estimates, /jobs, /opportunities, /analytics)
 * still resolves - each is now a redirect to its real destination (see each
 * route's own page.tsx) - never a second, competing navigation destination
 * for the same concept.
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
