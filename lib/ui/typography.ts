// Typographic hierarchy for the redesigned Trackpr visual language. Weight,
// size, and color are spent deliberately - not every heading is the same
// weight, not every label is the same size - so hierarchy reads before the
// words do.

export const pageTitleClass = "text-2xl font-semibold tracking-tight text-slate-900";
export const pageDescriptionClass = "text-sm text-slate-500";

/**
 * Reserved for the one (or two) sections on a page that should genuinely
 * lead the eye - e.g. a dashboard's "Needs your attention." Do not use this
 * for every section; that would just recreate uniform-heading syndrome with
 * a different font size.
 */
export const primarySectionTitleClass = "text-sm font-semibold text-slate-900";

/**
 * Every other named section. The label recedes so the section's own content
 * (numbers, names, rows) carries the visual weight instead of its heading.
 */
export const sectionLabelClass = "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

export const metaClass = "text-xs text-slate-500";

/**
 * The label/value pair used by every integrated stat strip (dashboard
 * overview, Leads summary, and future list pages) instead of boxed metric
 * cards - the number carries the weight, the label recedes.
 */
export const statLabelClass = "text-xs text-slate-500";
export const statValueClass = "mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900";

/**
 * The label/value pair used by every detail-page field group (a lead,
 * contact, appointment, or conversation's identity/status/value facts) -
 * previously duplicated verbatim across four detail pages.
 */
export const detailLabelClass = "text-xs font-medium uppercase tracking-wide text-slate-400";
export const detailValueClass = "mt-1 text-sm text-slate-900";

/** A named sub-section heading within a page (e.g. a Settings section). */
export const subsectionTitleClass = "text-sm font-semibold text-slate-900";
