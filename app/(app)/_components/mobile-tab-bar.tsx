"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal, X, LogOut } from "lucide-react";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { getNavGroupsForVertical, type NavIconName } from "./nav-items";
import { NavLink } from "./nav-link";
import { NAV_ICONS } from "./nav-icons";
import { logout } from "../actions";

/**
 * Phase 5 (nav and mobile pass): replaces the old hamburger-drawer pattern
 * on mobile with a persistent bottom tab bar - the four primary
 * destinations (Today/People/Money/Schedule, per vertical filtering) always
 * one tap away, never behind a menu. Everything else (Dashboard, Inbox,
 * Opportunities, Reviews & Referrals, Auto follow-up, Numbers, Settings,
 * Agency Command Center when authorized) lives behind the fifth "More" tab,
 * which opens a bottom sheet rather than a second navigation surface -
 * reuses NavLink and getNavGroupsForVertical exactly as the desktop sidebar
 * does, so the two surfaces can never drift out of sync with each other.
 */
export function MobileTabBar({
  vertical,
  showAgencyLink,
  userEmail,
}: {
  vertical: OrganizationVertical;
  showAgencyLink: boolean;
  userEmail: string;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = usePathname();

  const groups = getNavGroupsForVertical(vertical, showAgencyLink);
  const primaryItems = groups.find((group) => group.label === null)?.items ?? [];
  const moreItems = groups.find((group) => group.label === "More")?.items ?? [];
  const isMoreActive = moreItems.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className="lg:hidden">
      <nav
        className="relative z-40 flex items-stretch border-t border-white/[0.07] bg-[#0a120f]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {primaryItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium"
            >
              <NavTabIcon iconName={item.icon} active={isActive} />
              <span className={isActive ? "text-emerald-400" : "text-slate-500"}>{item.label}</span>
            </Link>
          );
        })}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium"
        >
          <MoreHorizontal className={`h-[18px] w-[18px] shrink-0 ${isMoreActive ? "text-emerald-400" : "text-slate-500"}`} aria-hidden />
          <span className={isMoreActive ? "text-emerald-400" : "text-slate-500"}>More</span>
        </button>
      </nav>

      {/* Always mounted so open/close animates, matching the old drawer's
          own pattern (see the mobile-nav.tsx this replaced). */}
      <div className={`fixed inset-0 z-50 ${moreOpen ? "" : "pointer-events-none"}`} aria-hidden={!moreOpen}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={moreOpen ? 0 : -1}
          className={`absolute inset-0 bg-slate-950/60 transition-opacity duration-200 ${moreOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => setMoreOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More"
          className={`absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-2xl bg-[#0a120f] shadow-2xl transition-transform duration-200 ease-out ${
            moreOpen ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
            <p className="text-sm font-semibold text-white">More</p>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              aria-label="Close menu"
              tabIndex={moreOpen ? 0 : -1}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>

          <div className="space-y-0.5 px-3 py-3">
            {moreItems.map((item) => (
              <NavLink key={item.href} item={item} onNavigate={() => setMoreOpen(false)} />
            ))}
          </div>

          <div className="border-t border-white/[0.07] p-3">
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <p className="truncate text-sm font-medium text-white">{userEmail}</p>
            </div>
            <form action={logout} className="mt-1">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                <LogOut className="h-[18px] w-[18px] shrink-0 text-slate-500" aria-hidden />
                Log out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// Renders a primary tab's icon without the full NavLink chrome (this tab
// bar's own layout - icon above label, no leading gap - doesn't match
// NavLink's sidebar-row anatomy), while still sourcing the icon from the
// exact same NavIconName -> component lookup NavLink itself uses, so a tab
// bar icon can never drift from its sidebar/More-sheet counterpart.
function NavTabIcon({ iconName, active }: { iconName: NavIconName; active: boolean }) {
  const Icon = NAV_ICONS[iconName];
  return <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-emerald-400" : "text-slate-500"}`} aria-hidden />;
}
