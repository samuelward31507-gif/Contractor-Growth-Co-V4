"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  CalendarClock,
  Briefcase,
  TrendingUp,
  Star,
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
  MessageSquare,
  CalendarClock,
  Briefcase,
  TrendingUp,
  Star,
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
export function NavLink({ item, onNavigate, collapsed }: { item: NavItem; onNavigate?: () => void; collapsed?: boolean }) {
  const pathname = usePathname();
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = ICONS[item.icon];

  if (collapsed) {
    // Rail mode: icon only, centered, with a CSS-only tooltip (no new
    // dependency - this repo has no tooltip primitive installed) that
    // reveals the label on hover/focus, per the "tooltips identify
    // destinations when collapsed" requirement.
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={isActive ? "page" : undefined}
        aria-label={item.label}
        className={`group/tip relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a120f] ${
          isActive ? "bg-emerald-500/[0.14] ring-1 ring-inset ring-emerald-500/25" : "hover:bg-white/[0.06]"
        }`}
      >
        <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-emerald-400" : "text-slate-400"}`} aria-hidden />
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100"
        >
          {item.label}
        </span>
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a120f] ${
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
