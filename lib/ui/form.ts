// Focus state uses the same accent (emerald) tokens as every button tier -
// every text input, select, and search field in the app shares this class,
// so a generic slate/black focus ring here was the one place a user's own
// cursor never met the brand color, in a product whose buttons, active nav
// state, and hero glow all do.
export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

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
// Trackpr 2.0, Phase 3A: every button tier below gained a `focus-visible`
// ring (keyboard/assistive-tech focus only - never shown on a mouse click,
// via the `:focus-visible` pseudo-class Tailwind's `focus-visible:` variant
// maps to) - previously none of these five tiers had any custom focus
// state at all, relying solely on the browser's own default outline, which
// varies by browser and is easy to miss against a colored button fill.
// Ring color matches each tier's own semantic color.
export const primaryButtonClass =
  "inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-emerald-300";

// Same treatment as primaryButtonClass without the forced full width, for
// buttons placed inline (e.g. a right-aligned section "Save" action) rather
// than filling a dialog.
export const primaryButtonAutoClass =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-emerald-300";

export const errorBannerClass =
  "rounded-lg border border-danger-border bg-danger-muted px-3.5 py-2.5 text-sm text-danger-text";

export const successBannerClass =
  "rounded-lg border border-accent-border bg-accent-muted px-3.5 py-2.5 text-sm text-accent-text";

// Legacy alias, identical to primaryButtonAutoClass now that primary IS the
// accent tier (see that constant's comment) - kept so any existing import
// keeps working unchanged. Prefer primaryButtonAutoClass in new code.
export const accentButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-emerald-300";

// Premium-polish pass: the button hierarchy every route should reach for
// instead of hand-rolling its own "secondary"/"destructive" button classes
// (review-referral-panel.tsx, several dialogs, etc. each had their own
// near-identical copy). Four tiers - primary, secondary, ghost (tertiary),
// destructive - so a page never lets every button compete for attention;
// each has a `*AutoClass` variant (inline width) alongside the full-width
// default used by single-action dialogs/forms.
export const secondaryButtonClass =
  "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Tertiary - no border/fill until hovered. For low-emphasis actions (Cancel, Clear filters) that must never visually compete with a primary/secondary action beside them. */
export const ghostButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export const destructiveButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-danger px-4 py-2.5 text-sm font-semibold text-danger-foreground shadow-sm transition-colors hover:bg-danger-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-red-300";

export const destructiveGhostButtonAutoClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

// Compact variants for dense inline contexts (a detail-page action row, a
// table row's actions) where the full py-2.5 buttons above are too tall.
export const primaryButtonSmallClass =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground shadow-sm transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-emerald-300";

export const secondaryButtonSmallClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
