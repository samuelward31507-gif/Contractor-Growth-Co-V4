"use client";

import { NAV_GROUPS, AGENCY_NAV_ITEM, resolveActiveNavItem } from "./nav-items";
import { useNavLocation } from "./use-nav-location";

/**
 * Answers "where am I" in the top bar, present on every screen size - the
 * sidebar's active row already does this on desktop, but the sidebar is
 * hidden on mobile, so this is the one place both surfaces share. Pure
 * presentation over the same NAV_GROUPS and the same active-item resolver
 * the sidebar uses, so the two can never disagree about where you are.
 * AGENCY_NAV_ITEM is included unconditionally: this is a label lookup, never
 * an authorization check.
 */
const GROUPS = NAV_GROUPS.map((group) => (group.id === "system" ? { ...group, items: [...group.items, AGENCY_NAV_ITEM] } : group));
const ALL_ITEMS = GROUPS.flatMap((group) => group.items);

export function Breadcrumb() {
  const location = useNavLocation();
  const item = resolveActiveNavItem(ALL_ITEMS, location);

  if (!item) return <p className="text-sm text-ink-3">Trackpr</p>;

  const group = GROUPS.find((candidate) => candidate.items.includes(item));
  return (
    <p className="truncate text-sm text-ink-3">
      {group?.label ? <span>{group.label} / </span> : null}
      <span className="font-medium text-ink">{item.label}</span>
    </p>
  );
}

/**
 * Trackpr 2.0 (step 2D): the page name on the merged mobile header, where
 * the full "Group / Page" trail would crowd the status indicator - the
 * bottom tab bar already shows the section.
 */
export function MobilePageTitle() {
  const location = useNavLocation();
  const item = resolveActiveNavItem(ALL_ITEMS, location);
  return <p className="truncate text-[13px] font-semibold text-ink">{item?.label ?? "Trackpr"}</p>;
}
