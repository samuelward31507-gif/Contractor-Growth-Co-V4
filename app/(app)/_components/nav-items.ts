import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Users, Contact, MessageSquare, CalendarClock, FileText, Briefcase, Workflow, HeartPulse, BarChart3, Building2, Settings } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };
export type NavGroup = { label: string | null; items: NavItem[] };

/**
 * Trackpr 2.0 information architecture - maps directly onto the real,
 * existing routes (no route was invented for this). Two real gaps the
 * previous nav had are fixed here: Automations, Automation Health, and the
 * Agency Command Center were fully built, working routes reachable only by
 * typed URL (zero nav entries); /activity is reframed as "Analytics" (same
 * route, richer content - see that page) to match where the BI/AI-insights
 * destination the product brief asks for actually already lives. Icons are
 * lucide-react throughout, replacing the old hand-rolled inline-SVG Icon
 * system so the whole app shares one icon set (automations/agency already
 * used lucide directly - this makes that the only convention, not one of
 * two).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Customers",
    items: [
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/contacts", label: "Contacts", icon: Contact },
      { href: "/conversations", label: "Inbox", icon: MessageSquare },
    ],
  },
  {
    label: "Scheduling",
    items: [{ href: "/appointments", label: "Appointments", icon: CalendarClock }],
  },
  {
    label: "Sales",
    items: [
      { href: "/estimates", label: "Estimates", icon: FileText },
      { href: "/jobs", label: "Jobs", icon: Briefcase },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/automations", label: "Automations", icon: Workflow },
      { href: "/automation-health", label: "Automation Health", icon: HeartPulse },
    ],
  },
  {
    label: "Insights",
    items: [{ href: "/activity", label: "Analytics", icon: BarChart3 }],
  },
  {
    label: "Settings",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

/** Appended conditionally at render time (only for a real, verified agency admin - see sidebar-content.tsx), never unconditionally in NAV_GROUPS - a nav-visible link is not itself an authorization boundary, but it must never imply access a given user does not actually have. */
export const AGENCY_NAV_ITEM: NavItem = { href: "/agency", label: "Agency Command Center", icon: Building2 };
