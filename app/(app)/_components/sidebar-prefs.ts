/**
 * Pure logic behind SidebarContent's two locally-persisted preferences
 * (full rail collapse, and each nav group's own open/closed state), kept in
 * a plain .ts file (no JSX) so it's unit-testable under plain node:test -
 * this repo has no jsdom/React Testing Library, and Node's native
 * TypeScript support cannot parse a .tsx file's JSX (see
 * leads-toolbar-query.ts for the identical precedent).
 */

export const SIDEBAR_RAIL_STORAGE_KEY = "trackpr:sidebar-collapsed";
export const SIDEBAR_GROUPS_STORAGE_KEY = "trackpr:sidebar-open-groups";

/**
 * Theme upgrade: the rail preference is mirrored into a cookie so the
 * server renders the sidebar at the width the visitor left it - no
 * expanded-then-collapsed flash on every page load. localStorage stays the
 * fallback for a preference saved before the cookie existed.
 */
export const SIDEBAR_RAIL_COOKIE = "trackpr-sidebar-collapsed";

/** The cookie's raw value -> the server's initial rail state; null = never set (fall back to localStorage after mount). */
export function parseRailCookie(raw: string | undefined): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Keyboard toggle for the rail ("[" - the Linear convention), ignored while typing in a field or with a modifier held. */
export function isRailToggleKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, targetIsEditable: boolean): boolean {
  return event.key === "[" && !event.metaKey && !event.ctrlKey && !event.altKey && !targetIsEditable;
}

/** All groups default to open - matches the sidebar's original, non-collapsible behavior exactly. */
export function defaultOpenGroups(groupLabels: string[]): Record<string, boolean> {
  return Object.fromEntries(groupLabels.map((label) => [label, true]));
}

/** Guards a raw localStorage read: malformed/missing/non-object JSON is treated as "nothing stored yet," never a crash. */
export function parseStoredGroups(raw: string | null): Record<string, boolean> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, boolean>;
  } catch {
    return null;
  }
}

/** Flips exactly one group's open state, leaving every other stored preference untouched. */
export function toggleGroupState(current: Record<string, boolean>, label: string): Record<string, boolean> {
  return { ...current, [label]: !current[label] };
}
