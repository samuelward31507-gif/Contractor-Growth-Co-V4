import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Target,
  Inbox,
  CalendarDays,
  CalendarClock,
  FileText,
  Hammer,
  Wallet,
  TrendingUp,
  Star,
  Handshake,
  BarChart3,
  Workflow,
  Settings,
  Building2,
} from "lucide-react";
import type { NavIconName } from "./nav-items";

/**
 * The actual icon components, keyed by the plain-string NavIconName NavItem
 * carries across the Server -> Client boundary. Shared by NavLink (the
 * sidebar/More-sheet row) and MobileTabBar (the bottom tab icons) so the two
 * surfaces can never resolve the same icon name to two different
 * components.
 */
export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  LayoutDashboard,
  Users,
  Target,
  Inbox,
  CalendarDays,
  CalendarClock,
  FileText,
  Hammer,
  Wallet,
  TrendingUp,
  Star,
  Handshake,
  BarChart3,
  Workflow,
  Settings,
  Building2,
};
