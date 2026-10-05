import Link from "next/link";
import { ArrowRight, LogIn } from "lucide-react";
import { CinderMark } from "./logo";
import { LifecycleInstrument } from "./lifecycle";
import { TrackprShowcase } from "./trackpr-showcase";
import { Reveal } from "./reveal";
import { Badge, Button, CONTAINER, Eyebrow, H2, Section, TextLink } from "./ui";
import { FUTURE_VERTICALS, PILLARS, SIGN_IN_HREF, STAGES, TALK_HREF, TRACKPR_ANSWERS, TRACKPR_DEMO_HREF, TRACKPR_HREF, WHY } from "./content";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

/** Trackpr's own tile - the product's mark as the app shows it, used wherever Cinder points to Trackpr. */
export function TrackprTile({ className = "h-5 w-5 text-[11px]" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-[6px] bg-accent font-bold leading-none text-white ${className}`}>
      T
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hero - what Cinder is, the problem it solves, and that Trackpr is first.
// ---------------------------------------------------------------------------

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative pb-20 pt-14 sm:pb-28 sm:pt-24 lg:pb-32 lg:pt-28">
      <div className={CONTAINER}>
        <div className="cinder-rise">
          <Eyebrow>
            <span className="sm:hidden">Cinder · Revenue technology</span>
            <span className="hidden sm:inline">Cinder Revenue Company · Revenue technology</span>
          </Eyebrow>
        </div>
        <h1
          id="hero-title"
          className="cinder-rise mt-7 max-w-[1120px] text-balance text-[clamp(2.3rem,8.4vw,5.75rem)] font-semibold leading-[0.98] tracking-[-0.048em] sm:mt-8"
          style={{ animationDelay: "60ms" }}
        >
          Revenue systems built to turn more opportunities into revenue<span className="text-cinder-accent">.</span>
        </h1>
        <p className="cinder-rise mt-7 max-w-[540px] text-pretty text-[18px] leading-relaxed text-cinder-ink-2 sm:mt-9 sm:text-[21px]" style={{ animationDelay: "120ms" }}>
          Cinder connects every step between a new opportunity and a final payment — so less revenue slips through the gaps.
        </p>
        <div className="cinder-rise mt-9 flex flex-col gap-3 sm:mt-10 sm:flex-row sm:items-center" style={{ animationDelay: "180ms" }}>
          <Button href={TALK_HREF} arrow size="lg">
            Talk to Cinder
          </Button>
          <Button href={TRACKPR_HREF} variant="secondary" size="lg">
            Explore Trackpr
          </Button>
        </div>
        <Link
          href="/#trackpr"
          className={`cinder-rise group mt-8 inline-flex items-center gap-2.5 rounded-md text-sm text-cinder-ink-3 transition-colors hover:text-cinder-ink ${FOCUS}`}
          style={{ animationDelay: "240ms" }}
        >
          <TrackprTile />
          <span>
            <span className="font-medium text-cinder-ink">Trackpr</span> — the first revenue operating system from Cinder
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
        </Link>

        <div className="mt-14 sm:mt-20">
          <LifecycleInstrument />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Problem - white surface. Where revenue slips, stage by stage.
// ---------------------------------------------------------------------------

export function Problem() {
  return (
    <Section tone="surface" className="border-y border-cinder-line">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>The problem</Eyebrow>
          <h2 className={`mt-6 ${H2}`}>Revenue doesn&apos;t disappear all at once.</h2>
          <p className="mt-6 text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-[19px]">It leaks through small operational gaps. A late reply. A proposal nobody follows up. A payment nobody chases.</p>
          <p className="mt-4 text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-[19px]">
            Most businesses don&apos;t have a lead problem. They have a <span className="font-medium text-cinder-ink">follow-through</span> problem.
          </p>
          <div className="mt-10 flex items-center gap-3.5 border-t border-cinder-line pt-6">
            <CinderMark className="h-7 w-7" />
            <p className="text-lg font-semibold tracking-[-0.015em]">Cinder connects the pieces.</p>
          </div>
        </div>

        <Reveal>
          <ol aria-label="Where revenue slips" className="divide-y divide-cinder-line border-y border-cinder-line">
            {STAGES.map((stage, i) => (
              <li key={stage.key} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-4 py-5 sm:grid-cols-[40px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-6 sm:py-6">
                <span className="pt-1 font-mono text-[11px] text-cinder-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <span>
                  <span className="block text-[18px] font-semibold tracking-[-0.02em]">{stage.label}</span>
                  <span className="mt-0.5 block text-[15px] text-cinder-ink-2">{stage.question}</span>
                </span>
                <span className="col-start-2 mt-2 flex items-start gap-2.5 text-[14px] leading-snug text-cinder-ink-3 sm:col-start-3 sm:mt-1">
                  <span aria-hidden className="mt-[7px] h-[5px] w-[5px] shrink-0 rotate-45 border border-cinder-accent" />
                  <span>
                    <span className="sr-only">Where it slips: </span>
                    {stage.leak}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Platform - dark pine. The Cinder operating model: five disciplines laid
// over the seven stages they cover.
// ---------------------------------------------------------------------------

/** Grid placement of each discipline over the seven-stage ruler (lg). */
const PILLAR_SPAN: Record<string, string> = {
  capture: "lg:col-start-1 lg:col-span-1",
  engage: "lg:col-start-2 lg:col-span-2",
  convert: "lg:col-start-4 lg:col-span-2",
  operate: "lg:col-start-6 lg:col-span-2",
  grow: "lg:col-start-1 lg:col-span-7",
};

export function Platform() {
  return (
    <Section
      id="platform"
      tone="night"
      eyebrow="The Cinder system"
      title="One system for the revenue journey."
      intro="Five disciplines on one connected record. Each covers a stretch of the lifecycle. Together they cover all of it."
    >
      <Reveal className="mt-16 sm:mt-20">
        {/* The ruler - the seven stages the disciplines sit on (lg only). */}
        <ol aria-hidden className="hidden grid-cols-7 gap-2 border-b border-cinder-night-line pb-4 lg:grid">
          {STAGES.map((stage, i) => (
            <li key={stage.key} className="font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3">
              <span className="text-cinder-on-night-3/70">{String(i + 1).padStart(2, "0")}</span> {stage.label}
            </li>
          ))}
        </ol>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:mt-3 lg:grid-cols-7">
          {PILLARS.map((pillar, i) => (
            <li
              key={pillar.key}
              className={`group relative rounded-2xl bg-cinder-night-fill p-5 inset-ring inset-ring-cinder-night-line transition-colors duration-300 hover:bg-white/[0.07] sm:p-7 ${PILLAR_SPAN[pillar.key]} ${pillar.key === "grow" ? "sm:col-span-2" : ""}`}
            >
              <div className={pillar.key === "grow" ? "lg:flex lg:items-center lg:justify-between lg:gap-10" : ""}>
                <div className={pillar.key === "grow" ? "lg:flex lg:items-baseline lg:gap-8" : ""}>
                  <span className="font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className={`mt-3 text-[22px] font-semibold tracking-[-0.025em] sm:mt-6 sm:text-[24px] ${pillar.key === "grow" ? "lg:mt-0" : "lg:mt-10"}`}>{pillar.name}</h3>
                  <p className={`mt-2 max-w-[340px] text-[15px] leading-relaxed text-cinder-on-night-2 ${pillar.key === "grow" ? "lg:mt-0 lg:max-w-none" : ""}`}>{pillar.line}</p>
                </div>
                <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3 sm:mt-6 lg:hidden">{pillar.stages.join(" · ")}</p>
                {pillar.key === "grow" ? <p className="mt-6 hidden font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3 lg:mt-0 lg:block">Across every stage</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </Reveal>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Trackpr - the canvas introduction, then the product on a white stage.
// ---------------------------------------------------------------------------

export function Trackpr() {
  return (
    <section id="trackpr" aria-labelledby="trackpr-title" className="scroll-mt-16 bg-cinder-canvas">
      <div className={`${CONTAINER} pb-16 pt-20 sm:pb-20 sm:pt-28 lg:pt-36`}>
        {/* The hierarchy, stated as a lockup: Cinder -> Trackpr. */}
        <p className="flex items-center gap-3 text-sm text-cinder-ink-3">
          <span className="inline-flex items-center gap-2 font-medium text-cinder-ink">
            <CinderMark className="h-5 w-5" />
            Cinder
          </span>
          <span aria-hidden className="h-px w-8 bg-cinder-line-strong" />
          <span className="inline-flex items-center gap-2 font-medium text-cinder-ink">
            <TrackprTile />
            Trackpr
          </span>
          <span className="sr-only">: Trackpr is a product of Cinder.</span>
        </p>

        <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-20">
          <div>
            <h2 id="trackpr-title" className="text-[44px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[64px] lg:text-[80px]">
              Meet Trackpr.
            </h2>
            <p className="mt-5 text-balance text-[22px] font-medium leading-snug tracking-[-0.02em] text-cinder-ink-2 sm:text-[28px]">The first revenue operating system from Cinder.</p>
            <p className="mt-6 max-w-[500px] text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-[19px]">
              Trackpr gives a business visibility and follow-through across the whole revenue lifecycle — in one place.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={TRACKPR_HREF} arrow size="lg">
                Explore Trackpr
              </Button>
              <Button href={TRACKPR_DEMO_HREF} variant="secondary" size="lg">
                Try the interactive demo
              </Button>
            </div>
            {/* Product access for existing users - quieter than the marketing actions above. */}
            <p className="mt-6 text-sm text-cinder-ink-3">
              Already use Trackpr?{" "}
              <Link href={SIGN_IN_HREF} className={`group ml-1 inline-flex items-center gap-1.5 rounded font-medium text-cinder-ink transition-colors hover:text-cinder-accent ${FOCUS}`}>
                <LogIn className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                Sign in to Trackpr
              </Link>
            </p>
          </div>

          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-cinder-ink-3">One place to see</p>
            <ul className="mt-4 divide-y divide-cinder-line border-y border-cinder-line">
              {TRACKPR_ANSWERS.map((item) => (
                <li key={item.question} className="grid gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] sm:items-baseline sm:gap-6">
                  <p className="text-[16px] font-semibold tracking-[-0.015em]">{item.question}</p>
                  <p className="text-[14.5px] leading-relaxed text-cinder-ink-2">
                    {item.detail} <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-cinder-ink-3">· {item.area}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* The product on a white stage - the canvas gives way to the showcase. */}
      <div className="border-y border-cinder-line bg-cinder-surface py-12 sm:py-16 lg:py-20">
        <div className={CONTAINER}>
          <Reveal>
            <TrackprShowcase />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Why Cinder - dark pine, restrained.
// ---------------------------------------------------------------------------

const WHY_PROOF: Record<string, string> = { see: "Today", act: "Needs your attention", improve: "Analytics" };

export function WhyCinder() {
  return (
    <Section tone="night" eyebrow="Why Cinder" title="Not another place to enter information." intro="A CRM stores what already happened. Cinder is built around what happens next.">
      <ol className="mt-16 grid gap-px overflow-hidden rounded-2xl bg-cinder-night-line inset-ring inset-ring-cinder-night-line md:grid-cols-3 sm:mt-20">
        {WHY.map((item, i) => (
          <li key={item.key} className="bg-cinder-night">
            <Reveal delay={i * 90} className="flex h-full flex-col p-7 sm:p-10">
              <span className="font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-10 text-[32px] font-semibold tracking-[-0.035em] sm:mt-14 sm:text-[40px]">{item.title}</h3>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-cinder-on-night-2 sm:text-[17px]">{item.line}</p>
              <p className="mt-auto pt-10 font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3">
                In Trackpr · <span className="text-cinder-on-night">{WHY_PROOF[item.key]}</span>
              </p>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Industries - canvas. One live market for Trackpr; the rest clearly ahead.
// ---------------------------------------------------------------------------

export function Industries() {
  return (
    <Section
      id="industries"
      eyebrow="Industries"
      title="Built for revenue-heavy businesses."
      intro="Cinder builds for businesses where speed, follow-through and revenue visibility matter most. Trackpr launches with contractors and the trades."
    >
      <div className="mt-16 grid gap-4 sm:mt-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Reveal>
          <article className="flex h-full flex-col rounded-[24px] border border-cinder-line bg-cinder-surface p-7 shadow-[0_1px_2px_rgba(13,21,18,0.04)] sm:p-10">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-accent" />
                Live
              </Badge>
              <Badge tone="neutral">
                <TrackprTile className="h-3.5 w-3.5 rounded-[4px] text-[8px]" />
                Trackpr
              </Badge>
            </div>
            <h3 className="mt-10 text-[36px] font-semibold tracking-[-0.035em] sm:mt-14 sm:text-[48px]">Contractors &amp; trades</h3>
            <p className="mt-3 max-w-[520px] text-pretty text-[17px] leading-relaxed text-cinder-ink-2">Trackpr&apos;s first live vertical — shaped around how the trades win and deliver work, from the first call to the paid invoice.</p>
            <ol aria-label="The trades lifecycle in Trackpr" className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.06em] text-cinder-ink-2">
              {["Lead", "Estimate", "Job", "Invoice", "Payment"].map((step, i, all) => (
                <li key={step} className="flex items-center gap-2">
                  <span className="rounded-md bg-cinder-well px-2 py-1">{step}</span>
                  {i < all.length - 1 ? <ArrowRight aria-hidden className="h-3 w-3 text-cinder-ink-3" strokeWidth={1.75} /> : null}
                </li>
              ))}
            </ol>
            <div className="mt-auto pt-10">
              <TextLink href={TRACKPR_HREF}>Explore Trackpr</TextLink>
            </div>
          </article>
        </Reveal>

        <Reveal delay={90}>
          <div className="flex h-full flex-col rounded-[24px] border border-dashed border-cinder-line-strong p-7 sm:p-10">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-cinder-ink-3">Coming next</p>
            <p className="mt-3 text-pretty text-[17px] leading-relaxed text-cinder-ink-2">Future verticals Cinder is building toward. None is supported by Trackpr yet.</p>
            <ul className="mt-8 divide-y divide-cinder-line border-y border-cinder-line">
              {FUTURE_VERTICALS.map((name) => (
                <li key={name} className="flex items-center gap-3 py-3.5 text-[15px] text-cinder-ink-2">
                  <span aria-hidden className="h-[6px] w-[6px] shrink-0 rotate-45 border border-cinder-line-strong" />
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Company - canvas, editorial, no container.
// ---------------------------------------------------------------------------

export function Company() {
  return (
    <section id="company" aria-labelledby="company-title" className="scroll-mt-16 bg-cinder-canvas pb-20 sm:pb-28 lg:pb-36">
      <div className={CONTAINER}>
        <div className="grid gap-10 border-t border-cinder-line pt-16 sm:pt-20 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-20">
          <div>
            <Eyebrow>Company</Eyebrow>
            <h2 id="company-title" className={`mt-6 ${H2}`}>
              Cinder exists to make revenue less fragile.
            </h2>
          </div>
          <div className="lg:pt-14">
            <p className="text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-[19px]">
              A business shouldn&apos;t need a stack of disconnected tools, spreadsheets, inboxes, reminders and manual processes to know where its revenue stands.
            </p>
            <p className="mt-4 text-pretty text-[17px] font-medium leading-relaxed text-cinder-ink sm:text-[19px]">Cinder builds the systems that connect those pieces.</p>
            <dl className="mt-10 grid grid-cols-1 border-y border-cinder-line sm:grid-cols-3 sm:divide-x sm:divide-cinder-line">
              {[
                ["Company", "Cinder Revenue Company"],
                ["Flagship product", "Trackpr"],
                ["Focus", "Revenue-heavy businesses"],
              ].map(([term, value]) => (
                <div key={term} className="border-b border-cinder-line py-4 last:border-b-0 sm:border-b-0 sm:px-5 sm:first:pl-0">
                  <dt className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-cinder-ink-3">{term}</dt>
                  <dd className="mt-1.5 text-[15px] font-medium tracking-[-0.01em]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Final call to action - full-bleed dark pine, the page's conclusion.
// ---------------------------------------------------------------------------

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="bg-cinder-night text-cinder-on-night">
      <div className={`${CONTAINER} py-24 sm:py-32 lg:py-40`}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
          <div>
            <CinderMark tone="light" className="h-11 w-11" animate />
            <h2 id="cta-title" className="mt-10 text-balance text-[44px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[64px] lg:text-[80px]">
              Build a better revenue system.
            </h2>
          </div>
          <div className="lg:pb-3">
            <p className="max-w-[440px] text-pretty text-[17px] leading-relaxed text-cinder-on-night-2 sm:text-[19px]">
              Start with the lifecycle your business already runs. Cinder makes it visible, connected and actionable.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={TALK_HREF} variant="inverse" arrow size="lg">
                Talk to Cinder
              </Button>
              <Button href={TRACKPR_HREF} variant="inverse-secondary" size="lg">
                See Trackpr
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
