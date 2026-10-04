// A restrained "distinct surface" primitive for the redesigned Trackpr
// visual language - deliberately not used for ordinary section content
// (which sits flush on the page canvas, structured by dividers and
// typography instead). Reserve this for moments that genuinely warrant a
// visually separated surface, e.g. a confirmed empty state. Separate from
// lib/ui/section-card.tsx's SectionCard/Panel, the app's one bordered-
// container primitive for actual grouped content.

// Theme upgrade: an outlined (dashed) well instead of a grey fill - an
// empty section reads as "space reserved for this," not as a heavy block.
export const surfaceClass = "rounded-xl border border-dashed border-line-strong bg-surface/60";

// Theme upgrade: the one card surface - white, hairline, 8px, resting
// lift. SectionCard, Panel, StatCard and every page panel that used to
// repeat "rounded-lg border border-line bg-surface" compose this, so the
// card treatment is decided in one place.
export const cardClass = "rounded-xl border border-line bg-surface shadow-card";
