"use client";

/**
 * UI/UX redesign pass: a right-side sliding panel, for content that wants
 * more room and more context-in-place than lib/ui/dialog.tsx's centered
 * modal (a record's full detail, a secondary workspace panel) without
 * leaving the page behind entirely. Shares Dialog's exact accessibility
 * contract (focus moves in on open and returns to the trigger on close,
 * Tab/Shift+Tab trapped, Escape closes, body scroll locked while open) -
 * duplicated rather than extracted from Dialog, since the two have
 * different enough visual shells (centered vs. edge-anchored, fixed vs.
 * full-height) that a shared abstraction would need as many override props
 * as it saved lines.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({
  onClose,
  children,
  labelledBy,
  widthClassName = "max-w-lg",
}: {
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  /** e.g. "max-w-lg" (default) or "max-w-2xl" for a drawer that needs more room. */
  widthClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab" && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
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
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        aria-hidden
        className={`absolute inset-0 bg-slate-900/30 transition-opacity duration-150 ${entered ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative flex h-full w-full ${widthClassName} flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-2xl outline-none transition-transform duration-200 ease-out ${entered ? "translate-x-0" : "translate-x-full"}`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        {children}
      </div>
    </div>
  );
}
