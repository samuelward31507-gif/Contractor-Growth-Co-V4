// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "House"
  | "Users"
  | "Inbox"
  | "CalendarDays"
  | "Wallet"
  | "ChartColumn"
  | "Zap"
  | "Settings"
  | "Building2";

import type { OrganizationVertical } from "@/lib/auth/organization";
import { getTerminology } from "@/lib/verticals/terminology";

export type NavItem = {
  /** Always the final destination - never a next.config or page-level redirect (see navigation-performance.test.ts). May carry a query or a #fragment when two nav entries are two views of one route. */
  href: string;
  label: string;
  icon: NavIconName;
  /** Omitted = visible to every vertical. Money (estimates, jobs, invoices, payments) is contractor-specific. */
  verticals?: OrganizationVertical[];
  /** Extra path prefixes that count as "inside" this destination - legacy or detail routes that render under it (e.g. /appointments/[id] under Appointments). */
  activeFor?: string[];
};

/**
 * `id` is the stable key (sidebar collapse preferences, React keys); `label`
 * is what renders as the group heading - null for the pinned system group
 * (Settings, Agency Command Center).
 */
export type NavGroup = { id: string; label: string | null; items: NavItem[] };

/**
 * Batch 2 (navigation, shell & information architecture): the whole product
 * in two questions -
 *
 *   YOU      what needs me?         Today, People, Inbox, Schedule, Money, Insights
 *   TRACKPR  what is Trackpr doing? Trackpr
 *
 * with Settings (and, for a verified agency admin, Agency Command Center)
 * pinned at the foot. One entry per destination: the old two-views-of-one-
 * route entries (Contacts/Leads, Calendar/Appointments, Overview/Invoices/
 * Estimates/Jobs, Analytics/Opportunities, Reviews/Referrals) become views
 * INSIDE their destination (People's All/Leads, Schedule's own view switch,
 * Money's tabs), never competing sidebar rows.
 *
 * Nothing was removed - each retired destination is re-homed, and its old
 * URL still works:
 *   /dashboard, /opportunities                  -> Today
 *   /contacts, /customers, /leads (and [id])    -> People
 *   /inbox                                      -> Inbox (/conversations)
 *   /calendar, /appointments                    -> Schedule
 *   /work, /estimates, /jobs, /invoices         -> Money (detail pages stay where they are)
 *   /analytics, /activity                       -> Insights
 *   /automations, /automation-health, /growth   -> Trackpr (the technical
 *                                                  automation area and reviews/
 *                                                  referrals, reached from it)
 *
 * The in-app Trackpr destination lives at /autopilot: /trackpr is the public
 * Cinder product page (app/(cinder)/trackpr), which /how-it-works and
 * /services already redirect to, so the app cannot take that URL.
 *
 * Every href is the route the visitor actually lands on - never a redirect
 * (see navigation-performance.test.ts).
 */
export const TRACKPR_HREF = "/autopilot";

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "you",
    label: "You",
    items: [
      { href: "/today", label: "Today", icon: "House", activeFor: ["/dashboard", "/opportunities"] },
      { href: "/people", label: "People", icon: "Users", activeFor: ["/customers", "/contacts", "/leads"] },
      { href: "/conversations", label: "Inbox", icon: "Inbox", activeFor: ["/inbox"] },
      { href: "/schedule", label: "Schedule", icon: "CalendarDays", activeFor: ["/calendar", "/appointments"] },
      { href: "/money", label: "Money", icon: "Wallet", verticals: ["contractor"], activeFor: ["/work", "/estimates", "/jobs", "/invoices"] },
      { href: "/insights", label: "Insights", icon: "ChartColumn", activeFor: ["/analytics", "/activity"] },
    ],
  },
  {
    id: "trackpr",
    label: "Trackpr",
    items: [{ href: TRACKPR_HREF, label: "Trackpr", icon: "Zap", activeFor: ["/automations", "/automation-health", "/growth"] }],
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
 * People for a vertical with its own word for them (gym: "Members", via
 * lib/verticals/terminology.ts's peopleLabel), folds a
 * verified agency admin's AGENCY_NAV_ITEM into the system group, and drops
 * any group left empty.
 */
export function getNavGroupsForVertical(vertical: OrganizationVertical, showAgencyLink: boolean): NavGroup[] {
  const terminology = getTerminology(vertical);

  return NAV_GROUPS.map((group) => {
    let items = group.items
      .filter((item) => !item.verticals || item.verticals.includes(vertical))
      .map((item) => (item.href === "/people" ? { ...item, label: terminology.peopleLabel } : item));

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
 * ever active. On the item's own route (or below it: /people/123 is People,
 * /settings/sms is Settings) it qualifies only when every query param it
 * names is present in the URL, and the qualifying item matching the most
 * wins (ties go to the entry listed first) - query views INSIDE a
 * destination (/people?view=leads, /money?browse=invoices) stay on that
 * destination. A fragment counts in favor
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
