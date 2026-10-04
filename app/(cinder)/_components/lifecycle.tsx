import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { CinderMark } from "./logo";
import { ACTIVE_STAGE, STAGES, TRANSITIONS } from "./content";

/**
 * Cinder's operating model as an instrument: one record moving through the
 * seven stages from first contact to payment. Stages read as completed, in
 * progress or next; the three transitions where follow-through decides the
 * outcome carry the ember on the line itself - revenue is won or lost
 * between stages. Illustrative of the model, with no data and no figures.
 * The track draws once and the stages rise in order; both are off under
 * reduced motion.
 */

type StageState = "done" | "active" | "next";
const stateOf = (i: number): StageState => (i < ACTIVE_STAGE ? "done" : i === ACTIVE_STAGE ? "active" : "next");
const STATE_LABEL: Record<StageState, string> = { done: "Completed", active: "In progress", next: "Next" };
const transitionAfter = (i: number) => TRANSITIONS.find((t) => t.after === i);

function Node({ state }: { state: StageState }) {
  if (state === "done") {
    return (
      <span aria-hidden className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full bg-cinder-on-night text-cinder-night">
        <Check className="h-3.5 w-3.5" strokeWidth={2.75} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span aria-hidden className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full bg-cinder-night ring-2 ring-cinder-accent-on-night">
        <span className="h-2 w-2 rotate-45 bg-cinder-accent-on-night" />
      </span>
    );
  }
  return <span aria-hidden className="relative z-10 flex h-6 w-6 rounded-full bg-cinder-night inset-ring-[1.5px] inset-ring-cinder-on-night-3" />;
}

export function LifecycleInstrument() {
  return (
    <div className="relative overflow-hidden rounded-[24px] bg-cinder-night text-cinder-on-night shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_2px_4px_rgba(13,21,18,0.12),0_40px_80px_-40px_rgba(13,21,18,0.6)] ring-1 ring-black/40 sm:rounded-[28px]">
      <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-cinder-night-line px-5 py-4 sm:px-8">
        <div className="flex items-center gap-2.5">
          <CinderMark tone="light" className="h-[18px] w-[18px]" />
          <span className="text-sm font-medium">Revenue lifecycle</span>
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.12em] text-cinder-on-night-3 sm:inline">· One record</span>
        </div>
        <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3">
          <li className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 rounded-full bg-cinder-on-night" />
            <span>Completed</span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 rounded-full ring-2 ring-cinder-accent-on-night" />
            <span>In progress</span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="h-[2px] w-4 rounded bg-cinder-accent-on-night" />
            <span>Follow-through</span>
          </li>
        </ul>
      </div>

      {/* lg and up: the horizontal instrument. Each column owns a stage; the
          segment to its right is the transition into the next stage. */}
      <ol aria-label="The revenue lifecycle" className="relative hidden grid-cols-7 px-8 pb-10 pt-12 lg:grid">
        {STAGES.map((stage, i) => {
          const state = stateOf(i);
          const transition = transitionAfter(i);
          const last = i === STAGES.length - 1;
          return (
            <li key={stage.key} className="cinder-rise relative flex flex-col items-start pr-4" style={{ animationDelay: `${120 + i * 90}ms` }}>
              {!last ? (
                <span aria-hidden className="absolute left-6 right-0 top-[11px] h-[2px] overflow-hidden rounded-full bg-cinder-night-line">
                  <span
                    className={`cinder-draw block h-full w-full ${transition ? "bg-cinder-accent-on-night" : i < ACTIVE_STAGE ? "bg-cinder-on-night-3/70" : "bg-transparent"}`}
                    style={{ animationDelay: `${300 + i * 90}ms` }}
                  />
                </span>
              ) : null}
              {transition ? (
                <span className="absolute left-[calc(50%+12px)] top-[22px] -translate-x-1/2 whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.1em] text-cinder-accent-on-night">
                  {transition.label}
                </span>
              ) : null}
              <Node state={state} />
              <span className="mt-9 font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
              <span className={`mt-1.5 text-[17px] font-semibold tracking-[-0.02em] ${state === "next" ? "text-cinder-on-night-2" : ""}`}>{stage.label}</span>
              <span className="mt-1.5 max-w-[150px] text-[13px] leading-snug text-cinder-on-night-3">{stage.question}</span>
              <span className="sr-only">{STATE_LABEL[state]}.</span>
            </li>
          );
        })}
      </ol>

      {/* Below lg: the same instrument as a vertical rail, transitions labelled on the rail. */}
      <ol aria-label="The revenue lifecycle" className="relative px-5 py-6 sm:px-8 lg:hidden">
        {STAGES.map((stage, i) => {
          const state = stateOf(i);
          const transition = transitionAfter(i);
          const last = i === STAGES.length - 1;
          return (
            <li key={stage.key} className="cinder-rise relative grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-x-4" style={{ animationDelay: `${100 + i * 70}ms` }}>
              {!last ? (
                <span
                  aria-hidden
                  className={`absolute left-[11px] top-6 h-[calc(100%-24px)] w-[2px] rounded-full ${transition ? "bg-cinder-accent-on-night" : i < ACTIVE_STAGE ? "bg-cinder-on-night-3/60" : "bg-cinder-night-line"}`}
                />
              ) : null}
              <Node state={state} />
              <div className={last ? "" : transition ? "pb-9" : "pb-5"}>
                <p className={`text-[16px] font-semibold leading-6 tracking-[-0.015em] ${state === "next" ? "text-cinder-on-night-2" : ""}`}>{stage.label}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-cinder-on-night-3">{stage.question}</p>
                {transition ? <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.1em] text-cinder-accent-on-night">{transition.label}</p> : null}
              </div>
              <span className={`mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em] ${state === "active" ? "text-cinder-accent-on-night" : "text-cinder-on-night-3"}`}>{STATE_LABEL[state]}</span>
            </li>
          );
        })}
      </ol>

      <div className="relative flex flex-col gap-3 border-t border-cinder-night-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="text-sm font-medium text-cinder-on-night">Revenue is won or lost between stages.</p>
        <Link
          href="/#trackpr"
          className="group inline-flex items-center gap-1.5 rounded text-sm text-cinder-on-night-2 transition-colors hover:text-cinder-on-night focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent-on-night"
        >
          Trackpr runs this lifecycle for contractors
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
