/**
 * Usability audit fix (#7, Settings jump navigation): a lightweight sticky
 * left-hand section nav for the desktop-width settings form - navigation
 * only, plain anchor links to the page's own existing section ids (see
 * page.tsx's SettingsGroup, which now sets `id` from each group's real
 * label). No new settings sections, no change to the form fields, save
 * behavior, validation, or API calls underneath. Hidden below `lg` per the
 * audit's own instruction to preserve the existing vertical form on mobile
 * rather than force a second, compact mechanism.
 */
export function SettingsJumpNav({ groups }: { groups: { id: string; label: string }[] }) {
  return (
    <nav aria-label="Settings sections" className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
      <p className="text-xs font-medium text-ink-3">Settings</p>
      <ul className="mt-3 space-y-0.5 border-l border-line">
        {groups.map((group) => (
          <li key={group.id}>
            <a
              href={`#${group.id}`}
              className="block border-l-2 border-transparent py-1.5 pl-3 text-sm text-ink-3 transition-colors hover:border-line-strong hover:text-ink focus:outline-none focus-visible:border-accent focus-visible:text-ink"
            >
              {group.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
