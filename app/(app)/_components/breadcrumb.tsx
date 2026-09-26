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
export function Breadcrumb() {
  const pathname = usePathname();
  // Trackpr 2.0, Phase 1: Agency Command Center now lives inside the
  // existing System group (see nav-items.ts's own getNavGroupsForVertical),
  // not a separate "Agency" group - matched here so the breadcrumb's own
  // label never disagrees with what the sidebar actually shows. This is a
  // label-lookup table only (never an authorization check - see this file's
  // own header comment), so including AGENCY_NAV_ITEM unconditionally here
  // is harmless even for a user who could never actually reach /agency.
  const allGroups = NAV_GROUPS.map((group) => (group.label === "System" ? { ...group, items: [...group.items, AGENCY_NAV_ITEM] } : group));

  for (const group of allGroups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
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
