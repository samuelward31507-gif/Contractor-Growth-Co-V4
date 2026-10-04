"use client";

import { useEffect } from "react";

/**
 * Lands a fresh page load on its #fragment once the section exists. The
 * browser's own fragment jump runs before Today's content has streamed in
 * (and a server redirect into Today - /opportunities - lands without one
 * at all), so /today?view=by-type#opportunities could open at the top of
 * the page. Rendered inside the target section, this mounts only once that
 * section is in the DOM, then scrolls it to the top of <main> - the same
 * position an in-app click already gets (use-nav-location.ts). Renders
 * nothing, and does nothing unless the URL's fragment names this section.
 */
export function ScrollToAnchorOnLoad({ id }: { id: string }) {
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [id]);

  return null;
}
