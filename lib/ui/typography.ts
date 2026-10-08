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
export const heroClass = "text-[42px] font-semibold tracking-[-0.028em] text-ink";

// Trackpr final visual polish pass: page titles brought back down from 34px/
// font-bold to 24px/font-semibold. The 30px-then-34px escalation across two
// earlier passes was chasing "authority," but next to real KPI numbers
// (StatCard's own 28px kpiValueClass, a table's tabular figures) a 34px bold
// display-face H1 read as the loudest, heaviest thing on every single page -
// a marketing headline sitting on top of an operating tool, and the single
// biggest reason the product still read as "template" rather than
// Linear/Stripe/Ramp-restrained. A page title's job is orientation, not
// competing with the page's own numbers for attention - 24px keeps it on the
// Rubik display face (still clears that font's own 22px+ usage floor) while
// letting every real metric on the page carry the actual visual weight.
// Tracking eased from -0.024em to -0.015em to match: very tight negative
// tracking reads as considered at 34px+ but starts to look cramped at 24px.
//
// Trackpr 2.0 design system (step 2A): in-app page titles move off the
// Rubik display face onto Geist at 22px. Rubik's rounded forms read as
// friendly-marketing next to dense operational data; the product sans at a
// modest size reads as a calm, confident tool - the Linear/Stripe register.
// Final redesign: Geist everywhere - Rubik is no longer loaded.
export const pageTitleClass = "text-2xl font-semibold leading-[1.15] tracking-[-0.022em] text-ink sm:text-[28px]";
export const pageDescriptionClass = "text-sm text-ink-3";

/**
 * Phase 0 (foundations pass): a rung for the one or two card-level titles
 * on a page that need more presence than a plain sectionTitleClass heading
 * but sit below the page title itself (e.g. a hero stat card's own title).
 */
export const cardTitleClass = "text-[17px] font-semibold tracking-[-0.012em] text-ink";

/**
 * Phase 0 (foundations pass): the rung that was missing between the old
 * 24px/14px jump - a real section heading at 18px, still Geist (Rubik is
 * reserved for 22px and above), so there's finally something between a
 * page title and a receding label.
 */
export const sectionTitleClass = "text-[17px] font-semibold tracking-[-0.012em] text-ink";

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
export const labelClass = "text-xs font-semibold text-ink-3";

/**
 * Reserved for the one (or two) sections on a page that should genuinely
 * lead the eye - e.g. a dashboard's "Needs your attention." Do not use this
 * for every section; that would just recreate uniform-heading syndrome with
 * a different font size.
 */
export const primarySectionTitleClass = "text-base font-semibold tracking-[-0.01em] text-ink";

/**
 * Every other named section. Trackpr 2.0 (step 2G): the one section-heading
 * standard across the app - 14px semibold ink, the same as the Dashboard's
 * section headings (2E) - so every page's sections read at one level.
 * Sentence case, not uppercase - see this file's own header comment.
 */
export const sectionLabelClass = "text-base font-semibold tracking-[-0.01em] text-ink";

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
export const statLabelClass = "text-xs text-ink-3";
export const statValueClass = "mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums text-ink";

/** The label/value pair inside a StatCard - kept as named tokens (not
 * inlined in stat-card.tsx) so any bespoke stat layout can match it exactly. */
export const kpiLabelClass = "text-[13px] font-medium text-ink-3";
/**
 * `leading-[1.15]` rather than `leading-none`: most values here are short
 * numbers/currency that read fine either way, but a genuine few (e.g. "Not
 * enough data yet") are full sentences that wrap inside a StatCard's
 * ~1/4-1/5-width column - `leading-none` (line-height: 1) makes wrapped
 * lines visually collide at this font size, `leading-[1.15]` keeps single
 * numbers just as tight while giving wrapped text room to breathe.
 */
export const kpiValueClass = "mt-2.5 text-[26px] sm:text-[28px] xl:text-[30px] leading-none font-semibold tracking-[-0.03em] tabular-nums text-ink break-words";
export const kpiDescriptionClass = "mt-2.5 text-xs text-ink-3";

/**
 * The label/value pair used by every detail-page field group (a lead,
 * contact, appointment, or conversation's identity/status/value facts) -
 * previously duplicated verbatim across four detail pages.
 */
export const detailLabelClass = "text-xs font-medium text-ink-3";
export const detailValueClass = "mt-1 text-sm text-ink";

/**
 * A named sub-section heading within a page (e.g. a Settings section).
 * Phase 0 (foundations pass): bumped from 14px (text-sm, byte-identical to
 * primarySectionTitleClass below) to 15px on --ink - the two tokens no
 * longer collide, and each keeps its own distinct role: primarySectionTitleClass
 * for the one section that should dominate a page, this one for every
 * other named sub-section.
 */
export const subsectionTitleClass = "text-[15px] font-semibold tracking-[-0.008em] text-ink";

/**
 * Trackpr 2.0 full redesign: large tabular figures (a KPI headline number,
 * a Pipeline Value, a dollar amount leading a row) get the monospace family
 * already loaded for the app (next/font/google's Geist Mono, registered as
 * --font-mono in globals.css - no new font, no new dependency) instead of
 * the body sans. Tabular figures in a true numeric face read as precise and
 * considered rather than merely "large text" - reserve this for genuine
 * headline numbers, never body copy or labels.
 */
//
// Trackpr 2.0 design system (step 2A): headline numbers move from the
// monospace face back to the product sans with tabular figures and tight
// tracking. Monospace money reads as a developer console; tabular sans
// reads as a financial product (the Stripe register) while keeping digits
// aligned.
export const numericDisplayClass = "tabular-nums tracking-[-0.02em]";

/**
 * Final redesign: the page eyebrow - a small Geist Mono line above the page
 * title ("FRI · OCT 2", "Money", "Settings"). Used once per page, so the
 * uppercase tracking reads as a deliberate instrument label, not as the
 * all-caps-everywhere admin template the earlier passes moved away from.
 */
//
// Batch 1 (Cinder design foundation): the website's eyebrow - 11px, wider
// 0.14em tracking, and (via PageHeader / Eyebrow in lib/ui/page-header.tsx)
// a small ember diamond in front. Still once per page at most.
export const pageEyebrowClass = "inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase leading-4 tracking-[0.14em] text-ink-3";

/** Batch 1: the ember diamond that leads an eyebrow - decorative, 5px. */
export const eyebrowDiamondClass = "h-[5px] w-[5px] shrink-0 rotate-45 bg-brand";

/** Final redesign: record identifiers (invoice and estimate numbers) - Geist Mono, tabular, never larger than the row text. */
export const recordIdClass = "font-mono text-[12.5px] tabular-nums tracking-[-0.01em]";

/** Final redesign: a small count or figure set in Geist Mono (the attention panel's count pill). */
export const monoCountClass = "font-mono text-[11.5px] font-medium tabular-nums";
