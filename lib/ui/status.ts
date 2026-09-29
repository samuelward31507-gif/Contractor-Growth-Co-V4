/**
 * Phase 1 (components pass): status is never colour alone - every tone
 * pairs a band/tint treatment with an explicit word, so it stays legible
 * in sunlight, in greyscale, and for a viewer who can't separate red from
 * green. Urgency is carried by weight, not just hue: "urgent" gets a solid
 * fill, "soon" a tint, "good"/"done" recede - the worst thing on screen is
 * visually the loudest, nothing else competes with it.
 */
export type StatusTone = "urgent" | "soon" | "good" | "done";

export type StatusStyle = {
  /** The word itself - always rendered alongside the color, never implied by it alone. */
  label: string;
  /** Solid-fill band classes (background + text) - reserved for "urgent" only. */
  bandClass: string;
  /** Tinted, lower-emphasis classes for "soon". */
  tintClass: string;
  /** Text-only classes for "good"/"done", which carry no fill at all. */
  textClass: string;
};

/**
 * Contrast-verified against white/near-white backgrounds:
 *   urgent (#B3261E on white text)  6.5:1
 *   soon   (#8A5A00 on #FBF1DE)     5.3:1
 *   good   (#0A5C3C on #E7F4EC)     matches the app's existing --accent-text/-muted pair
 * "done" intentionally carries no band or tint - it's the recede state.
 */
export const STATUS_STYLES: Record<StatusTone, StatusStyle> = {
  urgent: {
    label: "Urgent",
    bandClass: "bg-danger text-danger-foreground",
    tintClass: "bg-danger-muted text-danger-text",
    textClass: "text-danger-text",
  },
  soon: {
    label: "Soon",
    bandClass: "bg-warning-muted text-warning-text",
    tintClass: "bg-warning-muted text-warning-text",
    textClass: "text-warning-text",
  },
  good: {
    label: "Good",
    bandClass: "bg-accent-muted text-accent-text",
    tintClass: "bg-accent-muted text-accent-text",
    textClass: "text-accent-text",
  },
  done: {
    label: "Done",
    bandClass: "text-ink-3",
    tintClass: "text-ink-3",
    textClass: "text-ink-3",
  },
};
