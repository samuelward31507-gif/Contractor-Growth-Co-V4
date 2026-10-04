// Auth-specific design tokens (login/signup only). Deliberately a separate
// file from lib/ui/form.ts, which is shared by every CRM page - a copy edit
// here (wording, spacing) must never ripple into the dashboard, settings,
// leads, etc. - but the actual VALUES (radius, shadow, focus ring) are kept
// identical to form.ts on purpose: a redesign audit found this file had
// drifted to rounded-md while every other control in the app uses rounded-lg
// (the app's one consistent radius tier for inputs/buttons), which made the
// login/signup screens feel like a different, disconnected product. Fixed
// here rather than merging the files outright, since the two forms' copy
// and layout still have nothing else in common.

// Theme upgrade: the same values, now on the design tokens instead of raw
// slate/red/emerald literals - the ink scale for text and the dark button,
// the line tokens for borders, the semantic banner families for status.
export const authInputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-4 shadow-control transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-inset disabled:text-ink-3";

export const authLabelClass = "text-sm font-medium text-ink-2";

export const authButtonClass =
  "inline-flex w-full items-center justify-center rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white shadow-control transition-colors hover:bg-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:bg-line-strong";

export const authErrorBannerClass =
  "flex items-start gap-2 rounded-lg border border-danger-border bg-danger-muted px-3.5 py-2.5 text-sm text-danger-text";

export const authSuccessBannerClass =
  "flex items-start gap-2 rounded-lg border border-accent-border bg-accent-muted px-3.5 py-2.5 text-sm text-accent-text";
