"use client";

import { useSyncExternalStore, type MouseEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { NavLocation } from "./nav-items";

/**
 * The current URL as the nav's active-item resolver needs it (see
 * resolveActiveNavItem in nav-items.ts). Path and query come from the App
 * Router, so they are correct on the server render too. The #fragment never
 * reaches the server and the router doesn't expose it, so it is read from
 * window.location - the only two nav entries that use one (Reviews /
 * Referrals) settle on the right item right after hydration.
 */
const NAV_HASH_EVENT = "trackpr:nav-hash";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_HASH_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_HASH_EVENT, onChange);
  };
}

/**
 * Every nav click announces itself once the router has applied the new URL,
 * so the fragment snapshot below is re-read.
 *
 * A link to another #fragment of the page you're already on (Reviews ->
 * Referrals on /growth) is handled here rather than by <Link>: the App
 * Router scrolls to the section but keeps the old fragment in the URL, so
 * the URL and the highlighted entry would disagree. The fragment is pushed
 * with history.pushState (which the App Router supports and stays in sync
 * with) and the section scrolled into view directly.
 */
export function handleNavClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex !== -1 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && href.slice(0, hashIndex) === window.location.pathname + window.location.search) {
    event.preventDefault();
    window.history.pushState(null, "", href);
    document.getElementById(href.slice(hashIndex + 1))?.scrollIntoView({ block: "start" });
  }
  announceNavClick();
}

export function announceNavClick() {
  window.setTimeout(() => window.dispatchEvent(new Event(NAV_HASH_EVENT)), 50);
}

export function useNavLocation(): NavLocation {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return { pathname, search: searchParams.toString(), hash };
}
