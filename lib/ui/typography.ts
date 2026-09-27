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

/**
 * Phase 0 (foundations pass): the largest rung, for the marketing/demo
 * surfaces that want a genuine hero moment - never used inside the
 * authenticated app shell, where pageTitleClass is already the ceiling.
 */
export const heroClass = "font-display text-[42px] font-bold tracking-[-0.026em] text-ink";

// Final visual polish pass: page titles bumped from text-2xl (24px) to
// text-3xl (30px, within the requested 28-32px range) so the page-level
// heading reads with real authority against the larger KPI-card numbers
// introduced alongside it - a single change here cascades to every route.
// Phase 0 (foundations pass): bumped again to 34px and moved onto the new
// Rubik display face (font-display, 22px+ only per that font's own usage
// rule) and the new --ink token - same cascade-on-import effect as the
// original bump.
export const pageTitleClass = "font-display text-[34px] font-bold tracking-[-0.024em] text-ink";
export const pageDescriptionClass = "text-sm text-slate-500";

/**
 * Phase 0 (foundations pass): a rung for the one or two card-level titles
 * on a page that need more presence than a plain sectionTitleClass heading
 * but sit below the page title itself (e.g. a hero stat card's own title).
 */
export const cardTitleClass = "font-display text-[22px] font-semibold tracking-[-0.014em] text-ink";

/**
 * Phase 0 (foundations pass): the rung that was missing between the old
 * 24px/14px jump - a real section heading at 18px, still Geist (Rubik is
 * reserved for 22px and above), so there's finally something between a
 * page title and a receding label.
 */
export const sectionTitleClass = "text-[18px] font-semibold tracking-[-0.011em] text-ink";

/**
 * Phase 0 (foundations pass): body copy at 16px, not 14 - this app's
 * primary users read it in a truck, not at a desk. --ink-2 (7.5:1) rather
 * than --ink, since this is high-volume reading text, not a heading.
 */
export const bodyClass = "text-base text-ink-2";

/**
 * Phase 0 (foundations pass): a small, weighted label tier distinct from
 * sectionLabelClass below - 12px/bold/wide tracking for real emphasis at
 * small size. Deliberately sentence case, not uppercase: this session's
 * earlier redesign pass removed uppercase tracking-wide labels app-wide
 * specifically because they read as generic-admin-template filler: this
 * tier keeps the same "why" that decision established, at a new size.
 */
export const labelClass = "text-xs font-bold tracking-[0.09em] text-ink-3";

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

// Phase 0 (foundations pass): moved onto --ink-3 (4.6:1, the contrast
// floor) rather than raw slate-500 - same size, token-driven color.
export const metaClass = "text-xs text-ink-3";

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

/**
 * A named sub-section heading within a page (e.g. a Settings section).
 * Phase 0 (foundations pass): bumped from 14px (text-sm, byte-identical to
 * primarySectionTitleClass below) to 15px on --ink - the two tokens no
 * longer collide, and each keeps its own distinct role: primarySectionTitleClass
 * for the one section that should dominate a page, this one for every
 * other named sub-section.
 */
export const subsectionTitleClass = "text-[15px] font-semibold tracking-[-0.006em] text-ink";

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
