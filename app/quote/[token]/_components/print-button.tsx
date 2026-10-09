"use client";

import { Printer } from "lucide-react";

/** Opens the browser's print dialog - "Save as PDF" is a destination there. Never printed itself. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-[40px] items-center gap-2 rounded-[6px] px-3 text-[13.5px] font-medium text-ink-3 transition-colors hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 print:hidden"
    >
      <Printer className="h-4 w-4" aria-hidden />
      Print or save as PDF
    </button>
  );
}
