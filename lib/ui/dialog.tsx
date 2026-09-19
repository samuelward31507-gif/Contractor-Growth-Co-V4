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
 */
import { useEffect, type ReactNode } from "react";

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
  // None of the hand-rolled dialogs this replaces closed on Escape - a small,
  // in-scope accessibility improvement now that there's one place to add it.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-lg font-semibold tracking-tight text-slate-900">
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
