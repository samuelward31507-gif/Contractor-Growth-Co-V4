"use client";

/**
 * Premium-polish pass: the one modal/dialog primitive for the whole app.
 * Before this, 12+ routes each hand-rolled the identical
 * `fixed inset-0 z-50` backdrop + centered panel markup (service-dialog.tsx,
 * delete-service-dialog.tsx, appointment-dialog.tsx, estimate-dialog.tsx,
 * lead-dialog.tsx, contact-dialog.tsx, delete-*-dialog.tsx, etc.) with small,
 * meaningless drift in padding/radius/backdrop opacity. This consolidates
 * that markup only - it intentionally does not change any dialog's actual
 * form fields, validation, or server actions.
 *
 * Phase 1 (components pass): five accessibility fixes, none of which touch
 * the public API (props are unchanged, so no caller needs editing):
 *  1. The backdrop used to be a `<button aria-label="Close">` rendered
 *     BEFORE the panel in DOM order - the first Tab in any dialog landed on
 *     an invisible full-screen button. It's a plain div now; the real,
 *     labelled close control lives inside the panel (top-right X below).
 *  2. Focus moves to the panel on open, and back to whatever triggered the
 *     dialog on close - previously neither happened, so focus stayed
 *     wherever it was (often the button that opened the dialog, but
 *     sometimes stranded on removed content).
 *  3. Tab/Shift+Tab are trapped inside the panel while it's open.
 *  4. `document.body` gets `overflow: hidden` while a dialog is open - the
 *     page behind it used to keep scrolling.
 *  5. A short fade + 8px rise on open, so the dialog reads as arriving
 *     rather than teleporting in.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  onClose,
  children,
  className = "",
  labelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** id of the element (usually a DialogTitle) that labels this dialog for assistive tech. */
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Fix 5: entrance animation - starts closed, flips open one paint later so
  // the transition actually runs (matches the mobile drawer's own
  // open-state-toggle pattern in mobile-nav.tsx, rather than introducing a
  // new @keyframes-based idiom this codebase doesn't otherwise use).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // None of the hand-rolled dialogs this replaces closed on Escape - a small,
  // in-scope accessibility improvement now that there's one place to add it.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // Fix 3: trap Tab/Shift+Tab inside the panel. Recomputed on every
      // keydown rather than cached once, since a dialog's own content
      // (e.g. a form growing an extra field) can change what's focusable
      // while it's open.
      if (event.key === "Tab" && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null,
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Fix 2 + Fix 4: move focus into the panel and lock body scroll on open;
  // restore both on close/unmount. The trigger element is whatever had
  // focus immediately before this effect runs (the button that opened the
  // dialog, in every real caller), captured once so a later focus change
  // elsewhere on the page can't clobber the restore target.
  useEffect(() => {
    const triggerElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusable ?? panelRef.current)?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      triggerElement?.focus();
    };
    // Deliberately empty deps - this must run exactly once on mount/unmount,
    // not on every onClose identity change (a caller passing an inline
    // arrow function would otherwise re-run this and re-steal focus). Both
    // values the effect reads (document.activeElement, document.body) are
    // globals, not props/state, so the lint rule has nothing to flag here.
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden
        className={`absolute inset-0 bg-slate-900/40 transition-opacity duration-[120ms] ${entered ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl outline-none transition-all duration-[120ms] ease-out ${
          entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
        } ${className}`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="pr-8 text-lg font-semibold tracking-tight text-slate-900">
      {children}
    </h2>
  );
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm text-slate-500">{children}</p>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex items-center justify-end gap-3">{children}</div>;
}
