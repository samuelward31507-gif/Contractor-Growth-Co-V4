import { CINDER_DESCRIPTOR, CINDER_MARK_EMBER, CINDER_MARK_RING, CINDER_MARK_VIEWBOX, CINDER_WORDMARK, CINDER_WORDMARK_WIDTH, CINDER_DESCRIPTOR_WIDTH } from "@/lib/cinder/brand-paths";

type Tone = "ink" | "light";

const FILL: Record<Tone, { mark: string; ember: string; word: string; descriptor: string }> = {
  ink: { mark: "fill-cinder-ink", ember: "fill-cinder-accent", word: "fill-cinder-ink", descriptor: "fill-cinder-ink-3" },
  light: { mark: "fill-cinder-on-night", ember: "fill-cinder-accent-on-night", word: "fill-cinder-on-night", descriptor: "fill-cinder-on-night-3" },
};

/**
 * The Cinder mark - a "C" whose stroke swells as it turns, led by a small
 * ember travelling ahead of its thin end. Decorative by default (the
 * surrounding link or heading names it); pass `title` when it stands alone.
 * `animate` plays the one-time spark arrival (skipped under reduced motion).
 */
export function CinderMark({ tone = "ink", className = "h-8 w-8", title, animate = false }: { tone?: Tone; className?: string; title?: string; animate?: boolean }) {
  const f = FILL[tone];
  return (
    <svg viewBox={CINDER_MARK_VIEWBOX} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path className={f.mark} d={CINDER_MARK_RING} />
      <path className={`${f.ember} ${animate ? "cinder-spark" : ""}`} d={CINDER_MARK_EMBER} />
    </svg>
  );
}

/**
 * Horizontal lockups: "horizontal" = mark + CINDER; "full" = mark + CINDER
 * over REVENUE COMPANY. Height-driven; width follows the artwork.
 */
export function CinderLogo({ tone = "ink", variant = "horizontal", className = "h-7 w-auto", title = "Cinder Revenue Company" }: { tone?: Tone; variant?: "horizontal" | "full"; className?: string; title?: string }) {
  const f = FILL[tone];
  const width = 56 + Math.max(CINDER_WORDMARK_WIDTH, variant === "full" ? CINDER_DESCRIPTOR_WIDTH : 0) + 1;
  return (
    <svg viewBox={`0 0 ${width} 48`} className={className} role="img" aria-label={title}>
      <path className={f.mark} d={CINDER_MARK_RING} />
      <path className={f.ember} d={CINDER_MARK_EMBER} />
      <path className={f.word} transform={variant === "full" ? "translate(56 6)" : "translate(56 14)"} d={CINDER_WORDMARK} />
      {variant === "full" ? <path className={f.descriptor} transform="translate(56 34.6)" d={CINDER_DESCRIPTOR} /> : null}
    </svg>
  );
}
