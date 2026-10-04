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
 */
export function SettingsJumpNav({ groups }: { groups: { id: string; label: string }[] }) {
  const [activeId, setActiveId] = useState(groups[0]?.id ?? null);

  useEffect(() => {
    const sections = groups.map((group) => document.getElementById(group.id)).filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      // A section counts as "current" once it reaches the top third of the scroll area.
      { root: document.getElementById("main-content"), rootMargin: "0px 0px -66% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [groups]);

  return (
    <nav aria-label="Settings sections" className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
      <p className="text-xs font-medium text-ink-3">Settings</p>
      <ul className="mt-3 space-y-0.5 border-l border-line">
        {groups.map((group) => (
          <li key={group.id}>
            <a
              href={`#${group.id}`}
              onClick={() => setActiveId(group.id)}
              aria-current={activeId === group.id ? "location" : undefined}
              className={`-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors focus:outline-none focus-visible:border-accent focus-visible:text-ink ${
                activeId === group.id ? "border-accent font-medium text-ink" : "border-transparent text-ink-3 hover:border-line-strong hover:text-ink"
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
