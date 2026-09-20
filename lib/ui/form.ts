export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

export const labelClass = "text-sm font-medium text-slate-700";

// Trackpr visual-system redesign: the app's primary-action tier is now the
// same emerald accent the Contractor Growth Co. marketing site uses for its
// own primary CTAs ("Get Started") - previously near-black, matching a
// design philosophy from an earlier pass that reserved emerald for a single
// "activate"-type action per page (see the now-legacy accentButtonAutoClass
// below). That philosophy is superseded here: green communicates primary
// actions app-wide, exactly one per screen/dialog at a time (a Save, a
// Send, an Add) - secondary/ghost/destructive stay neutral or red, so nothing
// competes with it. This single change cascades to every route that already
// imports primaryButtonClass/primaryButtonAutoClass/primaryButtonSmallClass
// (dialogs, forms, detail-page actions across leads/contacts/appointments/
// estimates/jobs/settings) rather than needing a per-page edit.
export const primaryButtonClass =
  "inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-emerald-300";

// Same treatment as primaryButtonClass without the forced full width, for
// buttons placed inline (e.g. a right-aligned section "Save" action) rather
// than filling a dialog.
export const primaryButtonAutoClass =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-emerald-300";

export const errorBannerClass =
  "rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700";

export const successBannerClass =
  "rounded-lg border border-accent-border bg-accent-muted px-3.5 py-2.5 text-sm text-accent-text";

// Legacy alias, identical to primaryButtonAutoClass now that primary IS the
// accent tier (see that constant's comment) - kept so any existing import
// keeps working unchanged. Prefer primaryButtonAutoClass in new code.
export const accentButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-emerald-300";

// Premium-polish pass: the button hierarchy every route should reach for
// instead of hand-rolling its own "secondary"/"destructive" button classes
// (review-referral-panel.tsx, several dialogs, etc. each had their own
// near-identical copy). Four tiers - primary, secondary, ghost (tertiary),
// destructive - so a page never lets every button compete for attention;
// each has a `*AutoClass` variant (inline width) alongside the full-width
// default used by single-action dialogs/forms.
export const secondaryButtonClass =
  "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Tertiary - no border/fill until hovered. For low-emphasis actions (Cancel, Clear filters) that must never visually compete with a primary/secondary action beside them. */
export const ghostButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50";

export const destructiveButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300";

export const destructiveGhostButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

// Compact variants for dense inline contexts (a detail-page action row, a
// table row's actions) where the full py-2.5 buttons above are too tall.
export const primaryButtonSmallClass =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-emerald-300";

export const secondaryButtonSmallClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
