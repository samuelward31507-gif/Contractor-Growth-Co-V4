"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "./nav-items";

/**
 * Trackpr visual-system redesign: active state is now an emerald signal on
 * the dark sidebar (left rail + tinted icon/label), not a gray box - "active
 * navigation" is explicitly one of the things green should communicate in
 * this app. Hover is a barely-there white overlay (dark-surface convention),
 * never the active color, so the two states stay visually distinct.
 */
export function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={`group relative flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-3 text-sm transition-colors duration-150 ${
        isActive ? "bg-white/[0.06] font-medium text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
      }`}
    >
      <span
        aria-hidden
        className={`absolute -left-4 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-emerald-400 transition-opacity duration-150 ${
          isActive ? "opacity-100" : "opacity-0"
        }`}
      />
      <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-300"}`} aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
