"use client";

import { usePathname } from "next/navigation";
import { NAV_GROUPS, AGENCY_NAV_ITEM } from "./nav-items";

/**
 * Answers "where am I" in the top bar, present on every screen size - the
 * sidebar's own active-item highlight already does this on desktop, but is
 * hidden behind the mobile drawer, so this is the one place both surfaces
 * share. A client component (needs the live pathname) kept deliberately
 * tiny - no data fetching, pure presentation over the same NAV_GROUPS the
 * sidebar itself renders from, so the two can never disagree about labels.
 */
// Phase 0 (Foundation Trust), item 2: Inbox's own nav item points at
// /inbox, a page-level redirect to /conversations (see app/(app)/inbox/
// page.tsx's own comment for why a redirect, not a dispatcher, is correct
// here). A visitor is never actually ON /inbox once the page has loaded -
// they're on /conversations - so the plain href match below would never
// fire for Inbox, and this fell back to bare "Trackpr" instead of "Inbox"
// for the whole time a visitor spends on the Inbox experience. This is the
// one real href/destination split in the whole nav (every other item's
// href IS the route the visitor actually lands on), so it gets a small,
// explicit alias map rather than a new field on every NavItem for a case
// that only exists once.
const BREADCRUMB_PATH_ALIASES: Record<string, string> = { "/conversations": "/inbox" };

export function Breadcrumb() {
  const pathname = usePathname();
  const resolvedPathname = Object.entries(BREADCRUMB_PATH_ALIASES).find(([realPath]) => pathname === realPath || pathname.startsWith(`${realPath}/`))?.[1] ?? pathname;
  // Trackpr 2.0, Phase 5: Agency Command Center now lives inside the More
  // group (see nav-items.ts's own getNavGroupsForVertical), not a separate
  // "Agency" group - matched here so the breadcrumb's own label never
  // disagrees with what the sidebar actually shows. This is a label-lookup
  // table only (never an authorization check - see this file's own header
  // comment), so including AGENCY_NAV_ITEM unconditionally here is harmless
  // even for a user who could never actually reach /agency.
  const allGroups = NAV_GROUPS.map((group) => (group.label === "More" ? { ...group, items: [...group.items, AGENCY_NAV_ITEM] } : group));

  for (const group of allGroups) {
    for (const item of group.items) {
      if (resolvedPathname === item.href || resolvedPathname.startsWith(`${item.href}/`)) {
        return (
          <p className="truncate text-sm text-slate-500">
            {group.label ? <span className="text-slate-400">{group.label} / </span> : null}
            <span className="font-medium text-slate-900">{item.label}</span>
          </p>
        );
      }
    }
  }

  return <p className="text-sm text-slate-500">Trackpr</p>;
}
