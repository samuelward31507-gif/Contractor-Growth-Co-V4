"use client";

/**
 * UI/UX redesign pass: a global Cmd+K / Ctrl+K command palette. Every entry
 * here maps to a real, already-existing destination or creation flow - the
 * same NAV_GROUPS the sidebar itself renders (so "what pages exist" never
 * drifts between the two), plus the three real record-creation dialogs
 * (add-contact-button.tsx / add-lead-button.tsx / add-estimate-button.tsx),
 * each of which now recognizes its own `?new=...` param specifically so this
 * menu can open them for real rather than merely linking to their page.
 * There is no backend full-text search across people (see next-step.ts's own
 * sibling investigation), so "Search People" opens /people - the one real
 * place that search already lives - rather than faking a global result list.
 * "Add lead" navigates to /people?view=leads&new=lead (Final Batch 3) - the
 * Leads view's header renders AddLeadButton for every organization, with or
 * without contacts (Today's header hides it until a contact exists). "Add contact" navigates to
 * /people?new=contact directly - People itself renders AddContactButton
 * (reused as-is from /contacts, per that button's own comment), so this
 * skips the /contacts -> /people redirect hop rather than routing through it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Search, UserPlus, FileText, Target } from "lucide-react";
import type { NavGroup } from "@/app/(app)/_components/nav-items";

type CommandAction = { id: string; label: string; hint?: string; href: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> };

function buildActions(navGroups: NavGroup[]): CommandAction[] {
  const navActions: CommandAction[] = navGroups.flatMap((group) =>
    group.items.map((item) => ({ id: `nav-${item.href}`, label: `Go to ${item.label}`, href: item.href, icon: Search })),
  );

  return [
    { id: "search-people", label: "Search contacts", hint: "Open Contacts and filter", href: "/people", icon: Search },
    ...navActions,
    { id: "add-contact", label: "Add contact", href: "/people?new=contact", icon: UserPlus },
    { id: "add-lead", label: "Add lead", href: "/people?view=leads&new=lead", icon: Target },
    { id: "create-estimate", label: "Create estimate", href: "/estimates?new=estimate", icon: FileText },
  ];
}

/** Theme upgrade: the visible way into the palette - the top bar's trigger dispatches this, so Cmd/Ctrl+K is no longer the only door. */
const OPEN_EVENT = "trackpr:open-command-menu";

const noSubscribe = () => () => {};

/** Final redesign: the shortcut hint names the viewer's own modifier - "⌘K" on Apple platforms, "Ctrl K" elsewhere (server render: "⌘K"). Display only; the listener accepts both either way. */
function useShortcutLabel(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => "⌘K",
  );
}

export function CommandMenuTrigger() {
  const shortcut = useShortcutLabel();
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      aria-label="Search or jump to"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-11 w-11 items-center justify-center gap-2 rounded-lg text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-9 sm:w-72 sm:justify-start sm:border sm:border-line sm:bg-surface sm:px-3 sm:shadow-control"
    >
      <Search className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="hidden flex-1 text-left text-[13px] sm:inline">Search or jump to…</span>
      <kbd className="hidden shrink-0 rounded-[5px] border border-line bg-inset px-1.5 py-px font-mono text-[10.5px] font-medium text-ink-3 sm:inline">{shortcut}</kbd>
    </button>
  );
}

export function CommandMenu({ navGroups }: { navGroups: NavGroup[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo(() => buildActions(navGroups), [navGroups]);
  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(trimmed));
  }, [actions, query]);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => {
          if (!current) {
            setQuery("");
            setActiveIndex(0);
          }
          return !current;
        });
      }
    }
    function handleOpenRequest() {
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    }
    document.addEventListener("keydown", handleGlobalKeyDown);
    window.addEventListener(OPEN_EVENT, handleOpenRequest);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown);
      window.removeEventListener(OPEN_EVENT, handleOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);

  function runAction(action: CommandAction) {
    setOpen(false);
    router.push(action.href);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const action = filtered[activeIndex];
      if (action) runAction(action);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]">
      <div aria-hidden className="absolute inset-0 bg-ink/25" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-popover"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or jump to..."
            aria-label="Command menu search"
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[4px] border border-line bg-canvas px-1.5 py-px font-sans text-[10.5px] font-medium text-ink-3">Esc</kbd>
        </div>
        <ul role="listbox" className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-ink-3">No matching actions.</li>
          ) : (
            filtered.map((action, index) => {
              const Icon = action.icon;
              return (
                <li key={action.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runAction(action)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-100 ${
                      index === activeIndex ? "bg-selected text-ink" : "text-ink-2"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 truncate">{action.label}</span>
                    {action.hint ? <span className="ml-auto shrink-0 truncate text-xs text-ink-3">{action.hint}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
