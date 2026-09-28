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
 * "Add lead" navigates to /today?new=lead - /today's own header is the one
 * live surface that renders AddLeadButton (the plain /leads route itself
 * redirects to /people, which renders AddContactButton instead - see
 * nav-items.ts's own IA consolidation comment).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, UserPlus, FileText, Target } from "lucide-react";
import type { NavGroup } from "@/app/(app)/_components/nav-items";

type CommandAction = { id: string; label: string; hint?: string; href: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> };

function buildActions(navGroups: NavGroup[]): CommandAction[] {
  const navActions: CommandAction[] = navGroups.flatMap((group) =>
    group.items.map((item) => ({ id: `nav-${item.href}`, label: `Go to ${item.label}`, href: item.href, icon: Search })),
  );

  return [
    { id: "search-people", label: "Search People", hint: "Open People and filter", href: "/people", icon: Search },
    ...navActions,
    { id: "add-contact", label: "Add contact", href: "/contacts?new=contact", icon: UserPlus },
    { id: "add-lead", label: "Add lead", href: "/today?new=lead", icon: Target },
    { id: "create-estimate", label: "Create estimate", href: "/estimates?new=estimate", icon: FileText },
  ];
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
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <div aria-hidden className="absolute inset-0 bg-slate-900/30" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or jump to..."
            aria-label="Command menu search"
            className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">Esc</kbd>
        </div>
        <ul role="listbox" className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-slate-400">No matching actions.</li>
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
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      index === activeIndex ? "bg-slate-50 text-slate-900" : "text-slate-700"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 truncate">{action.label}</span>
                    {action.hint ? <span className="ml-auto shrink-0 truncate text-xs text-slate-400">{action.hint}</span> : null}
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
