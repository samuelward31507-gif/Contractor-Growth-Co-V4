import type { ReactNode } from "react";

/**
 * Batch 1 (Cinder design foundation): a template (not a layout) re-mounts
 * on every navigation, so each page's content gets the one subtle rise
 * (`ui-rise`, 200ms, 4px - app/globals.css). The class is opt-in under
 * `prefers-reduced-motion: no-preference`, so with reduced motion the page
 * simply appears. The wrapper keeps the flex column <main> hands its child.
 */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="ui-rise flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>;
}
