"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays, LayoutDashboard, Hammer, Inbox, Menu, Users, X, LogOut, type LucideIcon } from "lucide-react";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { getNavGroupsForVertical, resolveActiveNavItem, type NavItem } from "./nav-items";
import { NavLink } from "./nav-link";
import { announceNavClick, useNavLocation } from "./use-nav-location";
import { logout } from "../actions";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";

/**
 * A bottom tab: either one nav destination (`href`) or a whole group
 * (`groupId` - Schedule stays lit on Calendar and Appointments alike).
 */
type Tab = { label: string; icon: LucideIcon; href: string; groupId?: string };

/**
 * The four destinations a contractor reaches for most on a phone - today's
 * picture, customer messages, the day's schedule, the work itself - in
 * reach of a thumb; everything else is one tap away in the More sheet.
 * A vertical without Jobs (gym) gets its member list in that slot.
 */
function tabsFor(vertical: OrganizationVertical, contactsLabel: string): Tab[] {
  return [
    { label: "Dashboard", icon: LayoutDashboard, href: "/today" },
    { label: "Inbox", icon: Inbox, href: "/conversations" },
    { label: "Schedule", icon: CalendarDays, href: "/schedule", groupId: "schedule" },
    vertical === "contractor" ? { label: "Jobs", icon: Hammer, href: "/jobs" } : { label: contactsLabel, icon: Users, href: "/people" },
  ];
}

/**
 * Trackpr 2.0 (step 2C): the light mobile navigation - a white bottom tab
 * bar in the same quiet system as the desktop sidebar, and a More sheet
 * that shows the complete grouped IA (Customers, Schedule, Work, Growth,
 * Insights, then Settings / Agency Command Center and the account), so
 * nothing reachable on desktop is out of reach on a phone. Driven by the
 * same getNavGroupsForVertical + resolveActiveNavItem as the sidebar, so
 * the two surfaces can never disagree.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const location = useNavLocation();

  const groups = getNavGroupsForVertical(vertical, showAgencyLink);
  const allItems = groups.flatMap((group) => group.items);
  const activeItem = resolveActiveNavItem(allItems, location);
  const activeGroupId = groups.find((group) => activeItem && group.items.includes(activeItem))?.id;
  const contactsLabel = allItems.find((item) => item.href === "/people")?.label ?? "Contacts";
  const tabs = tabsFor(vertical, contactsLabel);

  const isTabActive = (tab: Tab) => (tab.groupId ? activeGroupId === tab.groupId : activeItem?.href === tab.href);
  const menuActive = activeItem !== null && !tabs.some(isTabActive);

  // Keyboard/screen-reader handling for the sheet: focus moves into it on
  // open, Escape closes it, and focus returns to the More tab on close.
  useEffect(() => {
    if (!menuOpen) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  function closeMenu({ restoreFocus }: { restoreFocus: boolean }) {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }

  const sheetGroups = groups.filter((group) => group.id !== "system");
  const systemGroup = groups.find((group) => group.id === "system");

  return (
    <div className="lg:hidden">
      <nav
        aria-label="Primary"
        className="relative z-40 flex items-stretch border-t border-line bg-surface"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs.map((tab) => {
          const active = isTabActive(tab);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={announceNavClick}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium transition-colors ${FOCUS_RING} ${
                active ? "text-ink" : "text-ink-3"
              }`}
            >
              <Icon className={`h-5 w-5 shrink-0 ${active ? "text-accent" : ""}`} strokeWidth={1.75} aria-hidden />
              <span>{tab.label}</span>
            </Link>
          );
        })}

        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-current={menuActive ? "page" : undefined}
          className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium transition-colors ${FOCUS_RING} ${
            menuActive ? "text-ink" : "text-ink-3"
          }`}
        >
          <Menu className={`h-5 w-5 shrink-0 ${menuActive ? "text-accent" : ""}`} strokeWidth={1.75} aria-hidden />
          <span>More</span>
        </button>
      </nav>

      {/* Always mounted so open/close animates; `inert` while closed keeps
          every link inside it out of the tab order and the a11y tree. */}
      <div className={`fixed inset-0 z-50 ${menuOpen ? "" : "pointer-events-none"}`} inert={!menuOpen}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className={`absolute inset-0 bg-ink/25 transition-opacity duration-200 ${menuOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => closeMenu({ restoreFocus: true })}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More"
          className={`absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-xl border-t border-line bg-surface shadow-popover transition-transform duration-200 ease-out ${
            menuOpen ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line pl-4 pr-1.5">
            <p className="text-sm font-semibold text-ink">More</p>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => closeMenu({ restoreFocus: true })}
              aria-label="Close menu"
              className={`flex h-11 w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink ${FOCUS_RING}`}
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
            {sheetGroups.map((group) => (
              <SheetGroup key={group.id} label={group.label} items={group.items} activeItem={activeItem} onNavigate={() => closeMenu({ restoreFocus: false })} />
            ))}

            {systemGroup ? (
              <div className="mt-3 space-y-px border-t border-line pt-3">
                {systemGroup.items.map((item) => (
                  <NavLink key={item.href} item={item} active={item === activeItem} touch onNavigate={() => closeMenu({ restoreFocus: false })} />
                ))}
              </div>
            ) : null}

            <div className="mt-3 border-t border-line pt-3">
              <div className="flex items-center gap-2.5 px-2.5 py-1.5">
                <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inset text-[11px] font-semibold text-ink-2">
                  {userEmail.charAt(0).toUpperCase()}
                </span>
                <p className="min-w-0 truncate text-sm font-medium text-ink">{userEmail}</p>
              </div>
              <form action={logout}>
                <button
                  type="submit"
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink ${FOCUS_RING}`}
                >
                  <LogOut className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
                  Log out
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SheetGroup({ label, items, activeItem, onNavigate }: { label: string | null; items: NavItem[]; activeItem: NavItem | null; onNavigate: () => void }) {
  return (
    <div className="pt-3" role="group" aria-label={label ?? "Home"}>
      {label ? <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">{label}</p> : null}
      <div className="space-y-px">
        {items.map((item) => (
          <NavLink key={item.href} item={item} active={item === activeItem} touch onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}
