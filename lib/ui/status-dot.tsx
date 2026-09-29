/**
 * Trackpr 2.0 design system (step 2A): the single status indicator used
 * wherever the app says "this is working / this needs you / this is broken"
 * - the top bar's system status, health summaries, row states. A small dot
 * plus words, never color alone, so the meaning survives for color-blind
 * users and screen readers (the dot itself is decorative).
 *
 * Tones map to meaning, not decoration:
 *   healthy   - operating normally (the accent)
 *   attention - something needs a look soon (warning)
 *   critical  - something is broken or blocked (danger)
 *   neutral   - informational / paused / unknown
 */
export type StatusDotTone = "healthy" | "attention" | "critical" | "neutral";

const DOT_CLASS: Record<StatusDotTone, string> = {
  healthy: "bg-accent",
  attention: "bg-warning",
  critical: "bg-danger",
  neutral: "bg-ink-4",
};

const TEXT_CLASS: Record<StatusDotTone, string> = {
  healthy: "text-ink-2",
  attention: "text-warning-text",
  critical: "text-danger-text",
  neutral: "text-ink-3",
};

export function StatusDot({ tone, className = "" }: { tone: StatusDotTone; className?: string }) {
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]} ${className}`} />;
}

/** A dot followed by its label - the standard way to state a status in words. */
export function StatusLabel({ tone, children, className = "" }: { tone: StatusDotTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${TEXT_CLASS[tone]} ${className}`}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}
