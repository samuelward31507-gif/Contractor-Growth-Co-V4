// Icons are referenced by name (a plain string), not by component - NavItem
// crosses from this Server Component data into NavLink, a Client Component,
// and a LucideIcon component reference can't be serialized across that
// boundary. NavLink owns the actual name -> component lookup.
export type NavIconName =
  | "LayoutDashboard"
  | "Users"
  | "Contact"
  | "MessageSquare"
  | "CalendarClock"
  | "FileText"
  | "Briefcase"
  | "Workflow"
  | "HeartPulse"
  | "BarChart3"
  | "Building2"
  | "Settings";

export type NavItem = { href: string; label: string; icon: NavIconName };
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Trackpr visual-system redesign: four operator-facing groups instead of
 * seven thin ones (Customers/Scheduling/Sales/Automation/Insights/Settings
 * previously) - OPERATE holds everything a contractor touches running the
 * day-to-day business, AUTOMATE and INSIGHTS get their own single-purpose
 * groups since they're conceptually distinct from daily operations, SYSTEM
 * holds account-level configuration. Maps directly onto the real, existing
 * routes - no route was invented or removed for this regroup.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" }],
  },
  {
    label: "Operate",
    items: [
      { href: "/leads", label: "Leads", icon: "Users" },
      { href: "/contacts", label: "Contacts", icon: "Contact" },
      { href: "/conversations", label: "Inbox", icon: "MessageSquare" },
      { href: "/appointments", label: "Appointments", icon: "CalendarClock" },
      { href: "/estimates", label: "Estimates", icon: "FileText" },
      { href: "/jobs", label: "Jobs", icon: "Briefcase" },
    ],
  },
  {
    label: "Automate",
    items: [
      { href: "/automations", label: "Automations", icon: "Workflow" },
      { href: "/automation-health", label: "Automation Health", icon: "HeartPulse" },
    ],
  },
  {
    label: "Grow",
    items: [{ href: "/activity", label: "Analytics", icon: "BarChart3" }],
  },
  {
    label: "System",
    items: [{ href: "/settings", label: "Settings", icon: "Settings" }],
  },
];

/** Appended conditionally at render time (only for a real, verified agency admin - see sidebar-content.tsx), never unconditionally in NAV_GROUPS - a nav-visible link is not itself an authorization boundary, but it must never imply access a given user does not actually have. */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: "Building2" };
