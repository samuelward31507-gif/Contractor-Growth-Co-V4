"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { getNavGroupsForVertical, resolveActiveNavItem, type NavGroup, type NavItem } from "./nav-items";
import { NavLink, RailTooltip } from "./nav-link";
import { useNavLocation } from "./use-nav-location";
import { logout } from "../actions";
import { SIDEBAR_RAIL_COOKIE, SIDEBAR_RAIL_STORAGE_KEY, SIDEBAR_GROUPS_STORAGE_KEY, defaultOpenGroups, isRailToggleKey, parseStoredGroups, toggleGroupState } from "./sidebar-prefs";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** Saves the rail state where both the next server render (cookie) and the pre-cookie fallback (localStorage) read it. */
function persistRail(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_RAIL_STORAGE_KEY, String(collapsed));
  } catch {
    // Preference just won't persist across reloads - not worth surfacing.
  }
  document.cookie = `${SIDEBAR_RAIL_COOKIE}=${collapsed}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Final redesign: the dark desktop sidebar - the deep pine-ink plane that
 * anchors the shell (earlier passes: a light, hairline-edged surface). a compact brand row that lines up with the top bar, the
 * grouped IA (see nav-items.ts), a pinned system group, and the account
 * footer. No glow, no gradient, no oversized logo - the active row is the
 * only color on it.
 *
 * Two locally-persisted preferences carry over unchanged in behavior: each
 * labelled group can fold on its own, and the whole sidebar can collapse to
 * a 56px icon rail. The rail is never "mystery icons": every icon has a
 * tooltip and an accessible name, the active item keeps its fill and
 * accent, and a hairline separates the groups. Group folding defaults to
 * "everything open" on the server render and syncs from localStorage after
 * mount. Theme upgrade: the rail state is also kept in a cookie the layout
 * reads, so the server renders the sidebar at its saved width (no flash),
 * and "[" toggles it from anywhere outside a text field.
 */
export function SidebarContent({
  organizationName,
  userEmail,
  role,
  vertical,
  showAgencyLink,
  initialCollapsed = null,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  vertical: OrganizationVertical;
  /** Only ever true for a session-verified agency admin (see layout.tsx) - a hidden link is a UX convenience, never the actual authorization boundary, which /agency and its data reads enforce independently on every request. */
  showAgencyLink: boolean;
  /** The layout's read of the rail cookie; null = never saved, so the localStorage fallback decides after mount. */
  initialCollapsed?: boolean | null;
}) {
  const groups = getNavGroupsForVertical(vertical, showAgencyLink);
  const location = useNavLocation();
  const activeItem = resolveActiveNavItem(
    groups.flatMap((group) => group.items),
    location,
  );

  const mainGroups = groups.filter((group) => group.id !== "system");
  const systemGroup = groups.find((group) => group.id === "system");
  const foldableIds = mainGroups.filter((group) => group.label !== null).map((group) => group.id);

  const [railCollapsed, setRailCollapsed] = useState(initialCollapsed ?? false);
  // The keyboard listener is registered once, so it reads the current rail state through this ref.
  const railRef = useRef(railCollapsed);
  useEffect(() => {
    railRef.current = railCollapsed;
  }, [railCollapsed]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => defaultOpenGroups(foldableIds));

  // Both effects below do a deliberate, one-time bridge from localStorage
  // (an external system React can't read during SSR/first paint) into
  // React state, immediately after mount - the standard, hydration-safe way
  // to restore a browser-only preference. This is exactly the "synchronize
  // state from an external system" case react-hooks/set-state-in-effect's
  // own rule description calls out as legitimate, so it's suppressed on
  // both rather than restructured away.
  useEffect(() => {
    if (initialCollapsed !== null) return;
    try {
      const stored = window.localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY) === "true";
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRailCollapsed(stored);
      // Carry a pre-cookie preference over, so the next load renders it server-side.
      document.cookie = `${SIDEBAR_RAIL_COOKIE}=${stored}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // localStorage unavailable (private browsing, etc.) - stay expanded.
    }
  }, [initialCollapsed]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editable = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (!isRailToggleKey(event, editable)) return;
      event.preventDefault();
      const next = !railRef.current;
      setRailCollapsed(next);
      persistRail(next);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
  }, []);

  function toggleRail() {
    const next = !railCollapsed;
    setRailCollapsed(next);
    persistRail(next);
  }

  function toggleGroup(id: string) {
    setOpenGroups((current) => {
      const next = toggleGroupState(current, id);
      try {
        window.localStorage.setItem(SIDEBAR_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Same as above - a lost preference is not a functional failure.
      }
      return next;
    });
  }

  const initial = userEmail.charAt(0).toUpperCase();

  if (railCollapsed) {
    return (
      <div className="flex h-full w-14 flex-col">
        {/* The expand control takes the brand mark's place in the rail's
            header row - pinned, so it can never scroll out of reach. */}
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-dark-line">
          <RailTooltip label="Expand sidebar ( [ )">
            {(tip) => (
              <button
                type="button"
                onClick={toggleRail}
                aria-label="Expand sidebar"
                aria-expanded={false}
                aria-keyshortcuts="["
                {...tip}
                className={`flex h-8 w-8 items-center justify-center rounded-md text-on-dark-3 transition-colors hover:bg-dark-fill-strong hover:text-on-dark ${FOCUS_RING}`}
              >
                <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </RailTooltip>
        </div>

        <nav aria-label="Main" className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto py-2">
          {mainGroups.map((group) => (
            <RailGroup key={group.id} group={group} activeItem={activeItem} />
          ))}
        </nav>

        {systemGroup ? (
          <div className="flex flex-col items-center gap-0.5 border-t border-dark-line py-1.5">
            {systemGroup.items.map((item) => (
              <NavLink key={item.href} item={item} active={item === activeItem} collapsed />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-1 border-t border-dark-line py-1.5">
          <RailTooltip label={userEmail}>
            {(tip) => (
              <span
                tabIndex={0}
                role="img"
                aria-label={`Signed in as ${userEmail} (${role})`}
                {...tip}
                className={`flex h-7 w-7 items-center justify-center rounded-full bg-dark-fill-strong text-[11px] font-semibold text-on-dark-2 inset-ring inset-ring-dark-line ${FOCUS_RING}`}
              >
                {initial}
              </span>
            )}
          </RailTooltip>
          <form action={logout}>
            <RailTooltip label="Log out">
              {(tip) => (
                <button
                  type="submit"
                  aria-label="Log out"
                  {...tip}
                  className={`flex h-8 w-8 items-center justify-center rounded-md text-on-dark-3 transition-colors hover:bg-dark-fill-strong hover:text-on-dark ${FOCUS_RING}`}
                >
                  <LogOut className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                </button>
              )}
            </RailTooltip>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-60 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-dark-line pl-4 pr-2">
        <BrandMark />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-on-dark">Trackpr</p>
          <p className="mt-0.5 truncate text-[11.5px] text-on-dark-3" title={organizationName}>
            {organizationName}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleRail}
          aria-label="Collapse sidebar"
          aria-expanded
          title="Collapse sidebar ( [ )"
          aria-keyshortcuts="["
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-on-dark-3 transition-colors hover:bg-dark-fill-strong hover:text-on-dark ${FOCUS_RING}`}
        >
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        {mainGroups.map((group) => {
          if (group.label === null) {
            return (
              <div key={group.id} className="space-y-px">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} active={item === activeItem} />
                ))}
              </div>
            );
          }
          const isOpen = openGroups[group.id] !== false;
          // A folded group still shows the page you're on, so the active
          // state never disappears behind a collapsed heading.
          const visibleItems = isOpen ? group.items : group.items.filter((item) => item === activeItem);
          const headingId = `nav-group-${group.id}`;
          return (
            <div key={group.id} className="mt-4" role="group" aria-labelledby={headingId}>
              <button
                id={headingId}
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isOpen}
                className={`group/heading mb-1 flex h-6 w-full items-center justify-between rounded-md px-2.5 text-[11.5px] font-medium text-on-dark-3 transition-colors hover:text-on-dark-2 ${FOCUS_RING}`}
              >
                {group.label}
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 opacity-0 transition duration-150 group-hover/heading:opacity-100 group-focus-visible/heading:opacity-100 ${isOpen ? "" : "-rotate-90 opacity-100"}`}
                  aria-hidden
                />
              </button>
              {visibleItems.length > 0 ? (
                <div className="space-y-px">
                  {visibleItems.map((item) => (
                    <NavLink key={item.href} item={item} active={item === activeItem} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      {systemGroup ? (
        <div className="space-y-px border-t border-dark-line px-2 py-2">
          {systemGroup.items.map((item) => (
            <NavLink key={item.href} item={item} active={item === activeItem} />
          ))}
        </div>
      ) : null}

      <div className="border-t border-dark-line px-2 py-2">
        <div className="flex items-center gap-2.5 px-2.5 py-1.5">
          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-dark-fill-strong text-[11px] font-semibold text-on-dark-2 inset-ring inset-ring-dark-line">
            {initial}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-medium text-on-dark" title={userEmail}>
              {userEmail}
            </p>
            <p className="text-[11.5px] capitalize text-on-dark-3">{role}</p>
          </div>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-on-dark-2 transition-colors hover:bg-dark-fill hover:text-on-dark ${FOCUS_RING}`}
          >
            <LogOut className="h-4 w-4 shrink-0 text-on-dark-3" strokeWidth={1.75} aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The Trackpr mark - the existing pine "T" tile, given real presence: 32px,
 * a crisper bold glyph, a faint top highlight and a hairline edge, so it
 * reads cleanly on both the dark sidebar and the white mobile header.
 * Same mark, not a new logo concept.
 */
export function BrandMark() {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-[15px] font-bold leading-none tracking-[-0.02em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.18)] inset-ring inset-ring-black/10"
    >
      T
    </span>
  );
}

/** One group in the icon rail: a hairline above it (except the first), then its icons. */
function RailGroup({ group, activeItem }: { group: NavGroup; activeItem: NavItem | null }) {
  return (
    <>
      {group.label !== null ? <span aria-hidden className="my-1.5 h-px w-6 shrink-0 bg-dark-line" /> : null}
      <div role="group" aria-label={group.label ?? "Home"} className="flex flex-col items-center gap-0.5">
        {group.items.map((item) => (
          <NavLink key={item.href} item={item} active={item === activeItem} collapsed />
        ))}
      </div>
    </>
  );
}
