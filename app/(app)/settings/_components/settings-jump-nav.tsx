"use client";

import { useEffect, useState } from "react";

/**
 * Usability audit fix (#7, Settings jump navigation): a lightweight sticky
 * left-hand section nav for the desktop-width settings form - navigation
 * only, plain anchor links to the page's own existing section ids (see
 * page.tsx's SettingsGroup, which now sets `id` from each group's real
 * label). No new settings sections, no change to the form fields, save
 * behavior, validation, or API calls underneath. Hidden below `lg` per the
 * audit's own instruction to preserve the existing vertical form on mobile
 * rather than force a second, compact mechanism.
 *
 * Theme upgrade: the section currently in view is marked (pine edge, full
 * ink, aria-current) - observed against the shell's one scrolling region,
 * <main id="main-content">. Still plain anchor links underneath.
 * Final redesign: tracked from the scroll position instead of an
 * IntersectionObserver, so the final section is marked at the bottom.
 */
export function SettingsJumpNav({ groups }: { groups: { id: string; label: string }[] }) {
  const [activeId, setActiveId] = useState(groups[0]?.id ?? null);

  useEffect(() => {
    const root = document.getElementById("main-content");
    const sections = groups.map((group) => document.getElementById(group.id)).filter((el): el is HTMLElement => el !== null);
    if (!root || sections.length === 0) return;

    // Final redesign (scroll-highlight fix): the current section is the last
    // one whose top has reached the reading line near the top of the scroll area - and once
    // the scroll area is at its very bottom, the final section, even when it
    // is too short to ever reach that line (which is why the highlight used
    // to stop one short of the last group). Same anchors, same marking.
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      if (atBottom) {
        setActiveId(sections[sections.length - 1].id);
        return;
      }
      // A fixed reading line near the top (not a third of the viewport), so a short
      // group that a jump link scrolls to stays marked instead of yielding to the next.
      const line = rootTop + 120;
      let current = sections[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line) current = section;
      }
      setActiveId(current.id);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [groups]);

  return (
    <nav aria-label="Settings sections" className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
      <p className="text-xs font-medium text-ink-3">On this page</p>
      <ul className="mt-3 space-y-0.5 border-l border-line">
        {groups.map((group) => (
          <li key={group.id}>
            <a
              href={`#${group.id}`}
              onClick={() => setActiveId(group.id)}
              aria-current={activeId === group.id ? "location" : undefined}
              className={`-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors focus:outline-none focus-visible:border-accent focus-visible:text-ink ${
                activeId === group.id ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:border-line-strong hover:text-ink-2"
              }`}
            >
              {group.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
