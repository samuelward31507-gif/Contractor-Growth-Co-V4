import { Check } from "lucide-react";
import { CinderMark } from "./logo";
import { STAGES } from "./content";
import { TextLink } from "./ui";

/**
 * The hero's revenue-lifecycle instrument: the seven stages from first
 * contact to payment as one connected record. The three follow-through
 * points (response, estimate, payment) carry the ember. Horizontal from lg
 * up, a vertical rail below. Purely illustrative of the model - no data,
 * no figures. Nodes rise in sequence and the track draws once (both off
 * under reduced motion).
 */
export function LifecycleInstrument() {
  return (
    <div className="relative overflow-hidden rounded-[28px] bg-cinder-night text-cinder-on-night shadow-[0_1px_2px_rgba(13,21,18,0.18),0_30px_60px_-30px_rgba(13,21,18,0.55)]">
      {/* A faint measurement grid, fading out toward the edges - structure, not decoration. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(to_right,rgba(242,240,234,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(242,240,234,0.05)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_80%)]"
      />

      <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-cinder-night-line px-5 py-4 sm:px-7">
        <div className="flex items-center gap-2.5">
          <CinderMark tone="light" className="h-5 w-5" />
          <span className="text-sm font-medium text-cinder-on-night">Revenue lifecycle</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11.5px] text-cinder-on-night-3">
          <span className="hidden sm:inline">One record · lead to payment</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-accent-on-night" />
            Follow-through point
          </span>
        </div>
      </div>

      {/* Desktop: the horizontal track. */}
      <div className="relative hidden px-7 pb-9 pt-11 lg:block">
        <div aria-hidden className="absolute left-[calc(28px+(100%-56px)/14)] right-[calc(28px+(100%-56px)/14)] top-[58px] h-px bg-cinder-night-line">
          <div className="cinder-draw h-px w-full bg-gradient-to-r from-cinder-on-night-3/40 via-cinder-on-night-3/70 to-cinder-accent-on-night" />
        </div>
        <ol aria-label="The revenue lifecycle" className="relative grid grid-cols-7">
          {STAGES.map((stage, i) => (
            <li key={stage.key} className="cinder-rise flex flex-col items-center text-center" style={{ animationDelay: `${150 + i * 110}ms` }}>
              <span
                aria-hidden
                className={`relative flex h-7 w-7 items-center justify-center rounded-full ${
                  stage.pivotal ? "bg-cinder-accent-on-night text-cinder-night ring-[6px] ring-cinder-accent-on-night/15" : "bg-cinder-night text-cinder-on-night-2 ring-1 ring-cinder-on-night-3/60"
                }`}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
              </span>
              <span className="mt-5 font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
              <span className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">{stage.label}</span>
              <span className={`mt-2 rounded-full px-2.5 py-0.5 text-xs ${stage.pivotal ? "bg-cinder-accent-on-night/12 text-cinder-accent-on-night" : "bg-cinder-night-fill text-cinder-on-night-2"}`}>{stage.state}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Below lg: the same lifecycle as a vertical rail. */}
      <ol aria-label="The revenue lifecycle" className="relative px-5 py-6 sm:px-7 lg:hidden">
        {STAGES.map((stage, i) => (
          <li key={stage.key} className="cinder-rise relative flex items-center gap-4 py-2.5" style={{ animationDelay: `${120 + i * 80}ms` }}>
            {i < STAGES.length - 1 ? <span aria-hidden className="absolute left-[13px] top-[calc(50%+14px)] h-[calc(100%-28px)] w-px bg-cinder-night-line" /> : null}
            <span
              aria-hidden
              className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                stage.pivotal ? "bg-cinder-accent-on-night text-cinder-night ring-4 ring-cinder-accent-on-night/15" : "bg-cinder-night text-cinder-on-night-2 ring-1 ring-cinder-on-night-3/60"
              }`}
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            </span>
            <span className="w-6 font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">{stage.label}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs ${stage.pivotal ? "bg-cinder-accent-on-night/12 text-cinder-accent-on-night" : "bg-cinder-night-fill text-cinder-on-night-2"}`}>{stage.state}</span>
          </li>
        ))}
      </ol>

      <div className="relative flex flex-col gap-3 border-t border-cinder-night-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="text-sm text-cinder-on-night-2">Every stage on one connected record. Every gap visible.</p>
        <TextLink href="/#trackpr" tone="light">
          Trackpr runs this lifecycle for contractors
        </TextLink>
      </div>
    </div>
  );
}
