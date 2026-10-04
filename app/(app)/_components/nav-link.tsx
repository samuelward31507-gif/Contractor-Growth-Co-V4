"use client";

import { useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import type { NavItem } from "./nav-items";
import { NAV_ICONS } from "./nav-icons";
import { handleNavClick } from "./use-nav-location";

/**
 * Trackpr 2.0 (step 2C): the light navigation row. Quiet by default - ink-2
 * text, an ink-3 icon - with hover as a faint fill. The active row is the
 * one place color appears: a selected fill, full-ink text, and the pine
 * accent on its icon. aria-current marks it for assistive tech.
 * Final redesign: the desktop sidebar (and its icon rail) sits on the dark
 * pine-ink plane - rows are light text at two steps, hover is a faint light
 * fill, and the active row is a restrained lighter chip with a hairline
 * edge and the lighter pine on its icon. The touch rows of the mobile
 * sheet, which sits on white, keep the light treatment and selected fill.
 */
const ACTIVE_CHIP = "bg-dark-fill-strong text-on-dark inset-ring inset-ring-dark-line";
const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function NavLink({
  item,
  active,
  onNavigate,
  collapsed = false,
  touch = false,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  /** Desktop icon rail: icon only, the label in a tooltip and the accessible name. */
  collapsed?: boolean;
  /** 44px rows for touch surfaces (the mobile menu sheet). */
  touch?: boolean;
}) {
  const Icon = NAV_ICONS[item.icon];

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    handleNavClick(event, item.href);
    onNavigate?.();
  }

  if (collapsed) {
    return (
      <RailTooltip label={item.label}>
        {(tipHandlers) => (
          <Link
            href={item.href}
            onClick={handleClick}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            {...tipHandlers}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${FOCUS_RING} ${
              active ? "bg-dark-fill-strong text-accent-on-dark inset-ring inset-ring-dark-line" : "text-on-dark-3 hover:bg-dark-fill hover:text-on-dark"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
          </Link>
        )}
      </RailTooltip>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={handleClick}
      aria-current={active ? "page" : undefined}
      className={`group/nav flex w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 ${touch ? "min-h-11 text-sm" : "h-8"} ${FOCUS_RING} ${
        active ? (touch ? "bg-selected text-ink" : ACTIVE_CHIP) : touch ? "text-ink-2 hover:bg-hover hover:text-ink" : "text-on-dark-2 hover:bg-dark-fill hover:text-on-dark"
      }`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${active ? (touch ? "text-accent" : "text-accent-on-dark") : touch ? "text-ink-3 group-hover/nav:text-ink-2" : "text-on-dark-3 group-hover/nav:text-on-dark-2"}`}
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

type TipHandlers = {
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
};

/**
 * The collapsed rail's label tooltip. Rendered `position: fixed` from the
 * trigger's measured edge, so the sidebar's own overflow clipping (it
 * scrolls) can never cut it off. Shows on hover and on keyboard focus
 * (:focus-visible), never on a mouse click's focus. Purely visual: every
 * trigger carries the same text as its aria-label.
 */
export function RailTooltip({ label, children }: { label: string; children: (handlers: TipHandlers) => ReactNode }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  function show(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setPosition({ top: rect.top + rect.height / 2, left: rect.right + 10 });
  }

  const handlers: TipHandlers = {
    onMouseEnter: (event) => show(event.currentTarget),
    onMouseLeave: () => setPosition(null),
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
    },
    onBlur: () => setPosition(null),
  };

  return (
    <>
      {children(handlers)}
      {position ? (
        <span
          aria-hidden
          style={{ top: position.top, left: position.left }}
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-white shadow-popover"
        >
          {label}
        </span>
      ) : null}
    </>
  );
}
