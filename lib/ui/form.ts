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

// Batch 1 (Cinder design foundation): the website's design language moves
// into these same parts, still without per-page edits -
//   - Primary is the ink pill (dark ink fill, light text, fully rounded),
//     the Cinder site's own primary. Pine is no longer the CTA color - it
//     stays the success/healthy/active signal (Badge "success", StatusDot
//     "healthy"). Ember is never a fill.
//   - Secondary and destructive are pills too; ghost (row and icon actions)
//     keeps the 8px radius so dense rows stay tight.
//   - Focus is one treatment everywhere: a 2px ember outline, offset 2px
//     (decided globally in app/globals.css - FOCUS_RING below only removes
//     the browser default so that rule is the one that shows).
//   - A trailing ArrowRight nudges 2px on hover.

const FOCUS_RING = "focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50";
const TRANSITION = "transition-[background-color,border-color,box-shadow,color] duration-150";
const SIZE_MD = "min-h-11 px-4 py-2 text-sm sm:min-h-9";
const SIZE_SM = "min-h-11 px-3 py-1.5 text-xs sm:min-h-8";
const BASE = `inline-flex items-center justify-center gap-1.5 font-medium ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;
const PILL = "rounded-full";
const ARROW_NUDGE = "[&_svg.lucide-arrow-right]:transition-transform [&_svg.lucide-arrow-right]:duration-150 hover:[&_svg.lucide-arrow-right]:translate-x-0.5";

const PRIMARY = `${PILL} ${ARROW_NUDGE} bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(13,21,18,0.2)] hover:bg-primary-hover active:bg-primary-hover`;
const SECONDARY = `${PILL} ${ARROW_NUDGE} border border-line-strong bg-surface text-ink shadow-control hover:border-ink/40 hover:bg-hover active:bg-selected`;
const GHOST = `rounded-lg text-ink-2 hover:bg-hover hover:text-ink active:bg-selected`;
const DESTRUCTIVE = `${PILL} bg-danger text-danger-foreground hover:bg-danger-strong active:bg-danger-strong`;
const DESTRUCTIVE_GHOST = `rounded-lg text-danger hover:bg-danger-muted active:bg-danger-muted`;

// Inputs, selects, textareas and search fields. Batch 1: focus is the same
// ember the rest of the app uses (border plus the global 2px outline, see
// app/globals.css). min-h rather than h, so textareas keep growing.
export const inputClass =
  "w-full min-h-11 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-control placeholder:text-ink-4 transition-colors duration-150 focus:border-focus focus:outline-2 focus:outline-offset-0 focus:outline-focus disabled:cursor-not-allowed disabled:bg-inset disabled:text-ink-3 sm:min-h-9";

export const labelClass = "text-sm font-medium text-ink-2";

// The one primary action per screen/dialog (Save, Send, Add). Full-width
// variant for stacked forms and dialogs; Auto for inline placement.
export const primaryButtonClass = `${BASE} ${SIZE_MD} w-full ${PRIMARY}`;
export const primaryButtonAutoClass = `${BASE} ${SIZE_MD} ${PRIMARY}`;

export const errorBannerClass = "rounded-lg border border-danger-border bg-danger-muted px-3.5 py-2.5 text-sm text-danger-text";
export const successBannerClass = "rounded-lg border border-accent-border bg-accent-muted px-3.5 py-2.5 text-sm text-accent-text";

// Legacy name kept for existing callers - identical to primaryButtonAutoClass
// (Batch 1: the ink pill, like every primary action).
export const accentButtonAutoClass = `${BASE} ${SIZE_MD} ${PRIMARY}`;

export const secondaryButtonClass = `${BASE} ${SIZE_MD} w-full ${SECONDARY}`;
export const secondaryButtonAutoClass = `${BASE} ${SIZE_MD} ${SECONDARY}`;

export const ghostButtonClass = `${BASE} ${SIZE_MD} ${GHOST}`;

export const destructiveButtonAutoClass = `${BASE} ${SIZE_MD} ${DESTRUCTIVE}`;
export const destructiveGhostButtonAutoClass = `${BASE} ${SIZE_MD} ${DESTRUCTIVE_GHOST}`;

// Compact tiers for dense rows and inline row actions.
export const primaryButtonSmallClass = `${BASE} ${SIZE_SM} ${PRIMARY}`;
export const secondaryButtonSmallClass = `${BASE} ${SIZE_SM} ${SECONDARY}`;
