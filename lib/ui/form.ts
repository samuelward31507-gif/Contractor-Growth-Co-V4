// Trackpr 2.0 design system (step 2A): every form control and button tier in
// the app, built from a few shared parts so a size, radius, focus or disabled
// rule is decided once. Export names are unchanged - the 80+ importing files
// inherit the new system without per-page edits.
//
// The system:
//   - Size: 36px on desktop (min-h-9), a 44px touch floor on mobile
//     (min-h-11 below `sm`) - Apple/Google's recommended minimum. Small
//     buttons are 32px on desktop, still 44px to the touch.
//   - Radius: 6px (rounded-md) for every control; cards/panels use 8px.
//   - Color: the pine accent marks the one primary action per screen or
//     dialog. Secondary is a white control with the strong hairline; ghost is
//     text that gains a quiet fill on hover. Destructive is the only red.
//   - States: hover darkens or fills quietly, press darkens one more step,
//     focus shows a ring for keyboard focus only (`focus-visible`), disabled
//     is a plain 50% fade - no off-palette tints.

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50";
const TRANSITION = "transition-colors duration-150";
const SIZE_MD = "min-h-11 px-3.5 py-2 text-sm sm:min-h-9";
const SIZE_SM = "min-h-11 px-2.5 py-1.5 text-xs sm:min-h-8";
const BASE = `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;

const PRIMARY = `bg-accent text-accent-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_2px_rgba(9,83,63,0.28)] hover:bg-accent-strong active:bg-accent-strong focus-visible:ring-accent/40`;
const SECONDARY = `border border-line-strong bg-surface text-ink shadow-control hover:bg-hover active:bg-selected focus-visible:ring-ink/15`;
const GHOST = `text-ink-2 hover:bg-hover hover:text-ink active:bg-selected focus-visible:ring-ink/15`;
const DESTRUCTIVE = `bg-danger text-danger-foreground hover:bg-danger-strong active:bg-danger-strong focus-visible:ring-danger/40`;
const DESTRUCTIVE_GHOST = `text-danger hover:bg-danger-muted active:bg-danger-muted focus-visible:ring-danger/30`;

// Inputs, selects, textareas and search fields. Focus meets the accent, the
// same color every primary action uses, so a user's own cursor is always
// on-brand. min-h rather than h, so textareas keep growing.
export const inputClass =
  "w-full min-h-11 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-control placeholder:text-ink-4 transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-inset disabled:text-ink-3 sm:min-h-9";

export const labelClass = "text-sm font-medium text-ink-2";

// The one primary action per screen/dialog (Save, Send, Add). Full-width
// variant for stacked forms and dialogs; Auto for inline placement.
export const primaryButtonClass = `${BASE} ${SIZE_MD} w-full ${PRIMARY}`;
export const primaryButtonAutoClass = `${BASE} ${SIZE_MD} ${PRIMARY}`;

export const errorBannerClass = "rounded-lg border border-danger-border bg-danger-muted px-3.5 py-2.5 text-sm text-danger-text";
export const successBannerClass = "rounded-lg border border-accent-border bg-accent-muted px-3.5 py-2.5 text-sm text-accent-text";

// Legacy name kept for existing callers - identical to primaryButtonAutoClass
// since the accent became the app-wide primary color.
export const accentButtonAutoClass = `${BASE} ${SIZE_MD} ${PRIMARY}`;

export const secondaryButtonClass = `${BASE} ${SIZE_MD} w-full ${SECONDARY}`;
export const secondaryButtonAutoClass = `${BASE} ${SIZE_MD} ${SECONDARY}`;

export const ghostButtonClass = `${BASE} ${SIZE_MD} ${GHOST}`;

export const destructiveButtonAutoClass = `${BASE} ${SIZE_MD} ${DESTRUCTIVE}`;
export const destructiveGhostButtonAutoClass = `${BASE} ${SIZE_MD} ${DESTRUCTIVE_GHOST}`;

// Compact tiers for dense rows and inline row actions.
export const primaryButtonSmallClass = `${BASE} ${SIZE_SM} ${PRIMARY}`;
export const secondaryButtonSmallClass = `${BASE} ${SIZE_SM} ${SECONDARY}`;
