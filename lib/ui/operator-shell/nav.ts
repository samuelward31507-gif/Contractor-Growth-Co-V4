/**
 * Navigation data for the operator areas (Agency Command Center, Founder
 * Command Center). Icons are plain names - this data crosses from Server
 * Components into the client shell, and a component reference can't be
 * serialized across that boundary (the same reason app/(app)'s NavItem
 * carries a name).
 */
export type OperatorIconName =
  | "ArrowLeft"
  | "LayoutDashboard"
  | "TrendingUp"
  | "Activity"
  | "DollarSign"
  | "Receipt"
  | "Sun"
  | "CalendarDays"
  | "ListChecks"
  | "Handshake"
  | "LineChart"
  | "NotebookPen"
  | "UserPlus";

export type OperatorNavItem = {
  href: string;
  label: string;
  icon: OperatorIconName;
  /** Extra path prefixes that count as inside this item (e.g. detail pages). */
  activeFor?: string[];
  /** Only the exact path is active (for a section's root, e.g. /agency). */
  exact?: boolean;
};

export type OperatorNavGroup = { id: string; label: string; items: OperatorNavItem[] };

/** The item the current path belongs to - the most specific match wins. */
export function resolveOperatorActiveItem(groups: OperatorNavGroup[], pathname: string | null): OperatorNavItem | null {
  if (!pathname) return null;
  let best: { item: OperatorNavItem; length: number } | null = null;
  for (const item of groups.flatMap((group) => group.items)) {
    const prefixes = [item.href, ...(item.activeFor ?? [])];
    for (const prefix of prefixes) {
      const exactOnly = item.exact && prefix === item.href;
      const matches = pathname === prefix || (!exactOnly && pathname.startsWith(`${prefix}/`));
      if (matches && (!best || prefix.length > best.length)) best = { item, length: prefix.length };
    }
  }
  return best?.item ?? null;
}

export const AGENCY_NAV_GROUP: OperatorNavGroup = {
  id: "agency",
  label: "Agency",
  items: [
    { href: "/agency", label: "Overview", icon: "LayoutDashboard", exact: true, activeFor: ["/agency/organizations"] },
    { href: "/agency/handoffs", label: "Client handoffs", icon: "UserPlus" },
    { href: "/agency/expansion", label: "Expansion", icon: "TrendingUp" },
    { href: "/agency/usage", label: "Usage", icon: "Activity" },
    { href: "/agency/revenue", label: "Revenue", icon: "DollarSign" },
    { href: "/agency/costs", label: "Costs", icon: "Receipt" },
  ],
};

export const FOUNDER_NAV_GROUP: OperatorNavGroup = {
  id: "founder",
  label: "Founder",
  items: [
    { href: "/founder", label: "Home", icon: "Sun", exact: true },
    { href: "/founder/calendar", label: "Calendar", icon: "CalendarDays" },
    { href: "/founder/tasks", label: "Tasks & events", icon: "ListChecks" },
    { href: "/founder/deals", label: "Deals", icon: "Handshake" },
    { href: "/founder/metrics", label: "MRR & metrics", icon: "LineChart" },
    { href: "/founder/review", label: "Daily review", icon: "NotebookPen" },
  ],
};
