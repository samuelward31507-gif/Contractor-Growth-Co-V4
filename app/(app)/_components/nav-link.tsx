"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Contact,
  MessageSquare,
  CalendarClock,
  FileText,
  Briefcase,
  Workflow,
  BarChart3,
  Building2,
  Settings,
} from "lucide-react";
import type { NavItem, NavIconName } from "./nav-items";

// The actual icon components live here, in the Client Component - NavItem
// only ever carries the icon's name (a plain string) across the Server ->
// Client boundary from sidebar-content.tsx.
const ICONS: Record<NavIconName, LucideIcon> = {
  LayoutDashboard,
  Users,
  Contact,
  MessageSquare,
  CalendarClock,
  FileText,
  Briefcase,
  Workflow,
  BarChart3,
  Building2,
  Settings,
};

/**
 * Trackpr visual-system redesign: the active state is now a real filled,
 * emerald-tinted pill - not a thin left rail on a barely-different
 * background. This is meant to be unmistakable at a glance, matching how
 * the marketing site treats its one accent color: reserved, but decisive
 * where it's actually used. Hover stays a barely-there white overlay so it
 * never gets confused with the active state.
 */
export function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = ICONS[item.icon];

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors duration-150 ${
        isActive
          ? "bg-emerald-500/[0.14] font-semibold text-white ring-1 ring-inset ring-emerald-500/25"
          : "font-medium text-slate-400 hover:bg-white/[0.05] hover:text-slate-100"
      }`}
    >
      <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-emerald-400" : "text-slate-500"}`} aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
