"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, LayoutDashboard, TrendingUp, Activity, DollarSign, Receipt, Radar, LogOut } from "lucide-react";
import { logout } from "@/app/(app)/actions";
import { BrandMark } from "@/app/(app)/_components/sidebar-content";

/**
 * The Agency Command Center's navigation. Trackpr 2.0 (step 2G): the same
 * light shell language as the client app's sidebar (app/(app)/_components/
 * sidebar-content.tsx) - white surface, hairline edges, the small pine mark,
 * quiet rows, a selected fill with a pine icon for the active page - so
 * moving from a client workspace into Agency reads as the same product, an
 * operator area of it rather than a different app. Routes, the explicit
 * "Back to Trackpr" link, the admin label and logout are unchanged.
 */
const NAV_ITEMS = [
  { href: "/agency", label: "Overview", icon: LayoutDashboard },
  { href: "/agency/expansion", label: "Expansion", icon: TrendingUp },
  { href: "/agency/usage", label: "Usage", icon: Activity },
  { href: "/agency/revenue", label: "Revenue", icon: DollarSign },
  { href: "/agency/costs", label: "Costs", icon: Receipt },
  // Agent Operating Layer, Phase 1: the internal Chief of Staff console. It
  // renders in the client shell for the operator's own workspace, and the
  // page itself checks agency-admin status server-side.
  { href: "/insights/intelligence", label: "Intelligence", icon: Radar },
] as const;

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const ROW = `group/nav flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 lg:min-h-8 ${FOCUS_RING}`;

export function AgencySidebarContent({
  userEmail,
  isAdmin,
  onNavigate,
}: {
  userEmail: string;
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <BrandMark />
        <div className="min-w-0 leading-tight">
          <p className="text-[13px] font-semibold text-ink">Trackpr</p>
          <p className="truncate text-[11.5px] text-ink-3">Agency Command Center</p>
        </div>
      </div>

      <nav aria-label="Agency" className="flex-1 overflow-y-auto px-2 py-3">
        <Link href="/today" onClick={onNavigate} className={`${ROW} text-ink-2 hover:bg-hover hover:text-ink`}>
          <ArrowLeft className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
          <span className="truncate">Back to Trackpr</span>
        </Link>

        <p className="mb-1 mt-4 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">Agency</p>
        <div className="space-y-px">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === "/agency" ? pathname === "/agency" || pathname.startsWith("/agency/organizations") : pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`${ROW} ${active ? "bg-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? "text-accent" : "text-ink-3 group-hover/nav:text-ink-2"}`} strokeWidth={1.75} aria-hidden />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-line px-2 py-2">
        <div className="flex items-center gap-2.5 px-2.5 py-1.5">
          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inset text-[11px] font-semibold text-ink-2">
            {userEmail.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-medium text-ink" title={userEmail}>
              {userEmail}
            </p>
            <p className="text-[11.5px] text-ink-3">{isAdmin ? "Agency admin" : "Not an agency admin"}</p>
          </div>
        </div>
        <form action={logout}>
          <button type="submit" className={`${ROW} text-ink-2 hover:bg-hover hover:text-ink`}>
            <LogOut className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
