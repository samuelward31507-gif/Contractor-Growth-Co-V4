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

export const authInputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

export const authLabelClass = "text-sm font-medium text-slate-700";

export const authButtonClass =
  "inline-flex w-full items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:cursor-not-allowed disabled:bg-slate-300";

export const authErrorBannerClass =
  "flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700";

export const authSuccessBannerClass =
  "flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700";
