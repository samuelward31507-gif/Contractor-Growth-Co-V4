// Typographic hierarchy for the redesigned Trackpr visual language. Weight,
// size, and color are spent deliberately - not every heading is the same
// weight, not every label is the same size - so hierarchy reads before the
// words do.
//
// Trackpr 2.0 full redesign (design-tokens pass): uppercase tracking-wide
// labels were the app's default "section label" treatment everywhere -
// correct used once or twice per page, but the effect that made a page feel
// like a generic admin template once five or six of them stacked up. Every
// label token below moved to sentence case, sized to stay legible without
// the crutch of all-caps - this is a token-level change, so every page that
// already imports these constants gets the calmer treatment for free,
// without a per-page edit.

// Final visual polish pass: page titles bumped from text-2xl (24px) to
// text-3xl (30px, within the requested 28-32px range) so the page-level
// heading reads with real authority against the larger KPI-card numbers
// introduced alongside it - a single change here cascades to every route.
export const pageTitleClass = "text-3xl font-semibold tracking-tight text-slate-900";
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
 * Sentence case, not uppercase - see this file's own header comment.
 */
export const sectionLabelClass = "text-[13px] font-medium text-slate-500";

export const metaClass = "text-xs text-slate-500";

/**
 * The label/value pair for an inline (non-card) stat, still used where a
 * compact strip genuinely reads better than a card grid (e.g. a detail
 * page's small facts row). For a page's PRIMARY kpi metrics, prefer
 * lib/ui/stat-card.tsx's StatGrid/StatCard instead - see its own header
 * comment for why boxed cards replaced the old integrated-row convention.
 */
export const statLabelClass = "text-xs text-slate-500";
export const statValueClass = "mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900";

/** The label/value pair inside a StatCard - kept as named tokens (not
 * inlined in stat-card.tsx) so any bespoke stat layout can match it exactly. */
export const kpiLabelClass = "text-[12.5px] font-medium text-slate-500";
/**
 * `leading-[1.15]` rather than `leading-none`: most values here are short
 * numbers/currency that read fine either way, but a genuine few (e.g. "Not
 * enough data yet") are full sentences that wrap inside a StatCard's
 * ~1/4-1/5-width column - `leading-none` (line-height: 1) makes wrapped
 * lines visually collide at this font size, `leading-[1.15]` keeps single
 * numbers just as tight while giving wrapped text room to breathe.
 */
export const kpiValueClass = "mt-2 text-[28px] leading-[1.15] font-semibold tracking-tight tabular-nums text-slate-900 break-words";
export const kpiDescriptionClass = "mt-2 text-xs text-slate-500";

/**
 * The label/value pair used by every detail-page field group (a lead,
 * contact, appointment, or conversation's identity/status/value facts) -
 * previously duplicated verbatim across four detail pages.
 */
export const detailLabelClass = "text-xs font-medium text-slate-500";
export const detailValueClass = "mt-1 text-sm text-slate-900";

/** A named sub-section heading within a page (e.g. a Settings section). */
export const subsectionTitleClass = "text-sm font-semibold text-slate-900";

/**
 * Trackpr 2.0 full redesign: large tabular figures (a KPI headline number,
 * a Pipeline Value, a dollar amount leading a row) get the monospace family
 * already loaded for the app (next/font/google's Geist Mono, registered as
 * --font-mono in globals.css - no new font, no new dependency) instead of
 * the body sans. Tabular figures in a true numeric face read as precise and
 * considered rather than merely "large text" - reserve this for genuine
 * headline numbers, never body copy or labels.
 */
export const numericDisplayClass = "font-mono tabular-nums";
