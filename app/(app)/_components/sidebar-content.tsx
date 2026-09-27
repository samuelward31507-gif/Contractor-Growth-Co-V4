"use client";

import { useEffect, useState } from "react";
import { LogOut, ChevronDown, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { getNavGroupsForVertical } from "./nav-items";
import { NavLink } from "./nav-link";
import { logout } from "../actions";
import { SIDEBAR_RAIL_STORAGE_KEY, SIDEBAR_GROUPS_STORAGE_KEY, defaultOpenGroups, parseStoredGroups, toggleGroupState } from "./sidebar-prefs";

/**
 * Trackpr 2.0, navigation simplification pass: the sidebar keeps its
 * existing dark surface/brand identity untouched, but now supports two
 * independent, locally-persisted preferences on top of it - each of the
 * four WORK/GROWTH/INTELLIGENCE/SYSTEM groups can collapse on its own, and
 * the whole sidebar can collapse into a narrow icon rail (desktop only,
 * gated by `allowRailCollapse` - the mobile drawer always renders expanded,
 * since a rail makes no sense inside an already-compact overlay). Both
 * preferences default to "everything open, not collapsed" on first render
 * (matching the sidebar's prior, non-collapsible behavior exactly) and are
 * synced from localStorage after mount - a real, if standard, one-frame
 * tradeoff, not a server/client value mismatch, since the server-rendered
 * HTML never depends on the stored preference.
 */
export function SidebarContent({
  organizationName,
  userEmail,
  role,
  vertical,
  showAgencyLink,
  onNavigate,
  allowRailCollapse = false,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  vertical: OrganizationVertical;
  /** Only ever true for a session-verified agency admin (see layout.tsx) - a hidden link is a UX convenience, never the actual authorization boundary, which /agency and its data reads enforce independently on every request. */
  showAgencyLink: boolean;
  onNavigate?: () => void;
  allowRailCollapse?: boolean;
}) {
  const groups = getNavGroupsForVertical(vertical, showAgencyLink);
  const groupLabels = groups.map((g) => g.label).filter((l): l is string => l !== null);

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => defaultOpenGroups(groupLabels));

  // Both effects below do a deliberate, one-time bridge from localStorage
  // (an external system React can't read during SSR/first paint) into
  // React state, immediately after mount - the standard, hydration-safe way
  // to restore a browser-only preference without the server and client's
  // first render disagreeing. This is exactly the "synchronize state from
  // an external system" case react-hooks/set-state-in-effect's own rule
  // description calls out as legitimate, not an accidental render cascade,
  // so it's suppressed on both rather than restructured away.
  useEffect(() => {
    if (!allowRailCollapse) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRailCollapsed(window.localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY) === "true");
    } catch {
      // localStorage unavailable (private browsing, etc.) - stay expanded.
    }
  }, [allowRailCollapse]);

  useEffect(() => {
    let stored: Record<string, boolean> | null = null;
    try {
      stored = parseStoredGroups(window.localStorage.getItem(SIDEBAR_GROUPS_STORAGE_KEY));
    } catch {
      // localStorage unavailable - stay on the "everything open" default.
    }
    if (!stored) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenGroups((current) => ({ ...current, ...stored }));
    // Only ever runs once, on mount - group labels are static for a given
    // vertical/session, so there is nothing to re-sync afterward.
  }, []);

  function toggleRail() {
    const next = !railCollapsed;
    setRailCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_RAIL_STORAGE_KEY, String(next));
    } catch {
      // Preference just won't persist across reloads - not worth surfacing.
    }
  }

  function toggleGroup(label: string) {
    setOpenGroups((current) => {
      const next = toggleGroupState(current, label);
      try {
        window.localStorage.setItem(SIDEBAR_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Same as above - a lost preference is not a functional failure.
      }
      return next;
    });
  }

  const isRail = allowRailCollapse && railCollapsed;

  return (
    <div className={`relative flex h-full flex-col overflow-hidden bg-[#0a120f] transition-[width] duration-200 ${isRail ? "w-[72px]" : "w-64"}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_-15%,rgba(16,185,129,0.10),transparent)]"
      />

      <div className={`relative flex items-center pb-4 pt-6 ${isRail ? "justify-center px-2" : "gap-2.5 px-5"}`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-sm font-bold text-slate-950">
          T
        </span>
        {isRail ? null : (
          <div className="min-w-0">
            <span className="block text-[15px] font-semibold leading-tight tracking-tight text-white">Trackpr</span>
            <p className="truncate text-[9.5px] font-semibold uppercase tracking-[0.16em] text-emerald-400/80">
              Contractor Growth Co.
            </p>
          </div>
        )}
      </div>

      {allowRailCollapse ? (
        <div className={`relative mb-1 ${isRail ? "px-2" : "px-4"}`}>
          <button
            type="button"
            onClick={toggleRail}
            aria-label={isRail ? "Expand sidebar" : "Collapse sidebar"}
            className={`flex items-center gap-2 rounded-lg text-xs font-medium text-slate-500 transition-colors hover:bg-white/[0.05] hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${
              isRail ? "h-9 w-9 justify-center" : "w-full px-2.5 py-2"
            }`}
          >
            {isRail ? <ChevronsRight className="h-4 w-4" aria-hidden /> : <ChevronsLeft className="h-4 w-4" aria-hidden />}
            {isRail ? null : "Collapse sidebar"}
          </button>
        </div>
      ) : null}

      {isRail ? null : (
        <div className="relative mx-4 mb-3 flex items-center gap-2 truncate rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-inset ring-white/[0.07]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
          <p className="truncate text-xs font-medium text-slate-300">{organizationName}</p>
        </div>
      )}

      <nav className={`relative flex-1 overflow-y-auto pb-4 ${isRail ? "space-y-1.5 px-2" : "space-y-6 px-3"}`}>
        {groups.map((group, index) => {
          const isOpen = group.label === null || openGroups[group.label] !== false;
          return (
            <div key={group.label ?? `group-${index}`}>
              {group.label && !isRail ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label as string)}
                  aria-expanded={isOpen}
                  className="mb-1.5 flex w-full items-center justify-between rounded px-3 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 transition-colors hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
                >
                  {group.label}
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${isOpen ? "" : "-rotate-90"}`} aria-hidden />
                </button>
              ) : null}
              {isOpen ? (
                <div className={isRail ? "space-y-1.5 flex flex-col items-center" : "space-y-0.5"}>
                  {group.items.map((item) => (
                    <NavLink key={item.href} item={item} onNavigate={onNavigate} collapsed={isRail} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="relative border-t border-white/[0.07] p-3">
        {isRail ? (
          <form action={logout} className="flex justify-center">
            <button
              type="submit"
              aria-label="Log out"
              className="group/tip relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/[0.05] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
            >
              <LogOut className="h-[18px] w-[18px]" aria-hidden />
              <span
                role="tooltip"
                className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity duration-150 group-hover/tip:opacity-100"
              >
                Log out
              </span>
            </button>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{userEmail}</p>
                <p className="text-xs capitalize text-slate-500">{role}</p>
              </div>
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
          </>
        )}
      </div>
    </div>
  );
}
