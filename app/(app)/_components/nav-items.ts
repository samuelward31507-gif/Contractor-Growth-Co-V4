// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "LayoutDashboard"
  | "Users"
  | "Target"
  | "Inbox"
  | "CalendarDays"
  | "CalendarClock"
  | "FileText"
  | "Hammer"
  | "Wallet"
  | "Receipt"
  | "TrendingUp"
  | "Star"
  | "Handshake"
  | "BarChart3"
  | "Workflow"
  | "Settings"
  | "Building2";

import type { OrganizationVertical } from "@/lib/auth/organization";
import { getTerminology } from "@/lib/verticals/terminology";

export type NavItem = {
  /** Always the final destination - never a next.config or page-level redirect (see navigation-performance.test.ts). May carry a query or a #fragment when two nav entries are two views of one route. */
  href: string;
  label: string;
  icon: NavIconName;
  /** Omitted = visible to every vertical. The Money group (Overview, Invoices, Estimates, Jobs) is contractor-specific. */
  verticals?: OrganizationVertical[];
  /** Extra path prefixes that count as "inside" this destination - legacy or detail routes that render under it (e.g. /appointments/[id] under Appointments). */
  activeFor?: string[];
};

/**
 * `id` is the stable key (sidebar collapse preferences, React keys); `label`
 * is what renders as the group heading - null for the ungrouped Today
 * entry and the pinned system group (Settings, Agency Command Center).
 */
export type NavGroup = { id: string; label: string | null; items: NavItem[] };

/**
 * Trackpr 2.0 information architecture (Phase 1 correction): one ungrouped
 * home, then People, Money, Schedule and Insights - the four questions an
 * owner asks (who, how the money stands, when, how it's going) - then More
 * for the less frequent areas, and a pinned system group at the foot of the
 * sidebar. The mobile tab bar is built from these same groups.
 *
 * Several entries are two views of one existing route - the redesign adds
 * navigation, never new pages or backend:
 *   Contacts / Leads        -> /people, /people?view=leads (every open lead, any temperature)
 *   Overview / Invoices     -> /money, /money?browse=invoices (Money's own tabs)
 *   Calendar / Appointments -> /schedule, /schedule?view=list
 *   Opportunities           -> /today?view=by-type#opportunities (Today's third act, every open opportunity by type)
 *   Reviews / Referrals     -> /growth#reviews, /growth#referrals (one page, two sections)
 * Every href is the route the visitor actually lands on: /contacts, /leads,
 * /calendar, /appointments, /opportunities and /analytics all still work as
 * compatibility redirects for old links, but navigation never pays their
 * extra round trip.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    label: null,
    items: [{ href: "/today", label: "Today", icon: "LayoutDashboard", activeFor: ["/dashboard"] }],
  },
  {
    id: "people",
    label: "People",
    items: [
      { href: "/people", label: "Contacts", icon: "Users", activeFor: ["/customers", "/contacts"] },
      { href: "/people?view=leads", label: "Leads", icon: "Target", activeFor: ["/leads"] },
      // Performance Pass A: points straight at /conversations - the route the
      // Inbox actually renders - instead of /inbox, a compatibility redirect.
      { href: "/conversations", label: "Inbox", icon: "Inbox", activeFor: ["/inbox"] },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      { href: "/money", label: "Overview", icon: "Wallet", verticals: ["contractor"], activeFor: ["/work"] },
      { href: "/money?browse=invoices", label: "Invoices", icon: "Receipt", verticals: ["contractor"], activeFor: ["/invoices"] },
      { href: "/estimates", label: "Estimates", icon: "FileText", verticals: ["contractor"] },
      { href: "/jobs", label: "Jobs", icon: "Hammer", verticals: ["contractor"] },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    items: [
      { href: "/schedule", label: "Calendar", icon: "CalendarDays", activeFor: ["/calendar"] },
      { href: "/schedule?view=list", label: "Appointments", icon: "CalendarClock", activeFor: ["/appointments"] },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    items: [
      { href: "/insights", label: "Analytics", icon: "BarChart3", activeFor: ["/analytics", "/activity"] },
      { href: "/today?view=by-type#opportunities", label: "Opportunities", icon: "TrendingUp", activeFor: ["/opportunities"] },
    ],
  },
  {
    id: "more",
    label: "More",
    items: [
      { href: "/growth#reviews", label: "Reviews", icon: "Star" },
      { href: "/growth#referrals", label: "Referrals", icon: "Handshake" },
      { href: "/automations", label: "Automations", icon: "Workflow", activeFor: ["/automation-health"] },
    ],
  },
  {
    id: "system",
    label: null,
    items: [{ href: "/settings", label: "Settings", icon: "Settings" }],
  },
];

/**
 * Appended conditionally at render time (only for a real, verified agency
 * admin - see layout.tsx), never unconditionally in NAV_GROUPS - a
 * nav-visible link is not itself an authorization boundary, but it must
 * never imply access a given user does not actually have. Lives in the
 * pinned system group, next to Settings.
 */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: "Building2" };

/**
 * Filters NAV_GROUPS down to items visible for a given vertical, relabels
 * Contacts via lib/verticals/terminology.ts (gym: "Members"), folds a
 * verified agency admin's AGENCY_NAV_ITEM into the system group, and drops
 * any group left empty (a gym has no Money group).
 */
export function getNavGroupsForVertical(vertical: OrganizationVertical, showAgencyLink: boolean): NavGroup[] {
  const terminology = getTerminology(vertical);

  return NAV_GROUPS.map((group) => {
    let items = group.items
      .filter((item) => !item.verticals || item.verticals.includes(vertical))
      .map((item) => (item.href === "/people" ? { ...item, label: terminology.contactsLabel } : item));

    if (group.id === "system" && showAgencyLink) {
      items = [...items, AGENCY_NAV_ITEM];
    }

    return { ...group, items };
  }).filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Active-item resolution
// ---------------------------------------------------------------------------

export type NavLocation = { pathname: string; search: string; hash: string };

function splitHref(href: string) {
  const [beforeHash, hash = ""] = href.split("#");
  const [path, query = ""] = beforeHash.split("?");
  return { path, params: new URLSearchParams(query), hash };
}

function isWithin(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The one nav item the current URL belongs to, or null. Exactly one item is
 * ever active, even where two entries share a route (Contacts/Leads,
 * Calendar/Appointments, Today/Opportunities, Reviews/Referrals): on the
 * item's own route it qualifies only when every query param it names is
 * present in the URL, and the qualifying item matching the most wins (ties
 * go to the entry listed first) - so /people?view=leads is Leads and
 * plain /people (or /people/123) is Contacts. A fragment counts in favor
 * when it matches and against when it doesn't, without disqualifying. An
 * `activeFor` prefix (a legacy or detail route) qualifies on the path
 * alone. Pure, so the sidebar, mobile tab bar and breadcrumb can never
 * disagree.
 */
export function resolveActiveNavItem(items: NavItem[], location: NavLocation): NavItem | null {
  const current = new URLSearchParams(location.search);
  const currentHash = location.hash.replace(/^#/, "");
  let best: { item: NavItem; score: number } | null = null;

  for (const item of items) {
    const { path, params, hash } = splitHref(item.href);
    let score = 0;
    if (isWithin(location.pathname, path)) {
      let qualifies = true;
      for (const [key, value] of params) {
        if (current.get(key) !== value) qualifies = false;
        score += 1;
      }
      // A fragment is only a scroll position on the same page, so it is a
      // preference, not a requirement: plain /growth still belongs to the
      // first of its entries (Reviews), and #referrals picks Referrals.
      if (hash) score += hash === currentHash ? 1 : -1;
      if (!qualifies) continue;
    } else if (!(item.activeFor ?? []).some((prefix) => isWithin(location.pathname, prefix))) {
      continue;
    }
    if (!best || score > best.score) best = { item, score };
  }

  return best?.item ?? null;
}
