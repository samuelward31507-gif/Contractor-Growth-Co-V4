import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CinderMark } from "./logo";
import { LifecycleInstrument } from "./lifecycle";
import { TrackprShowcase } from "./trackpr-showcase";
import { Reveal } from "./reveal";
import { Badge, Button, Card, CONTAINER, Eyebrow, Section, TextLink } from "./ui";
import { FUTURE_VERTICALS, PILLARS, STAGES, TALK_HREF, TRACKPR_ANSWERS, TRACKPR_DEMO_HREF, TRACKPR_HREF, WHY } from "./content";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden pb-16 pt-12 sm:pb-24 sm:pt-20 lg:pb-28 lg:pt-24">
      <div className={CONTAINER}>
        <div>
          <Link
            href="/#trackpr"
            className={`cinder-rise group inline-flex max-w-full items-center gap-2.5 rounded-full bg-cinder-surface py-1 pl-1 pr-3.5 text-[13px] text-cinder-ink-2 ring-1 ring-cinder-line transition-colors hover:ring-cinder-line-strong ${FOCUS}`}
          >
            <span className="rounded-full bg-cinder-ink px-2.5 py-0.5 text-xs font-medium text-cinder-on-night">Trackpr</span>
            <span className="truncate">
              <span className="sm:hidden">The first system from Cinder</span>
              <span className="hidden sm:inline">The first revenue operating system from Cinder</span>
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
          </Link>
          <h1 id="hero-title" className="cinder-rise mt-8 max-w-[1120px] text-balance text-[42px] font-semibold leading-[1.02] tracking-[-0.042em] sm:text-[60px] lg:text-[80px]" style={{ animationDelay: "60ms" }}>
            Revenue systems built to turn more opportunities into revenue<span className="text-cinder-accent">.</span>
          </h1>
          <div className="mt-8 flex flex-col gap-9 lg:mt-10 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
            <p className="cinder-rise max-w-[600px] text-pretty text-lg leading-relaxed text-cinder-ink-2 sm:text-xl" style={{ animationDelay: "120ms" }}>
              Cinder builds the systems behind the moments where revenue is won or lost — from the first lead to the final payment.
            </p>
            <div className="cinder-rise flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center" style={{ animationDelay: "180ms" }}>
              <Button href={TALK_HREF} arrow size="lg">
                Talk to Cinder
              </Button>
              <Button href={TRACKPR_HREF} variant="secondary" size="lg">
                Explore Trackpr
              </Button>
            </div>
          </div>
        </div>
        <div className="mt-14 sm:mt-16">
          <LifecycleInstrument />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Problem
// ---------------------------------------------------------------------------

export function Problem() {
  return (
    <Section tone="surface" className="border-y border-cinder-line">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mt-5 text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[44px] lg:text-[52px]">Revenue doesn&apos;t disappear all at once.</h2>
          <p className="mt-6 text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-lg">
            It leaks through small operational gaps. A reply that comes too late. An estimate nobody follows up. An invoice nobody chases.
          </p>
          <p className="mt-4 text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-lg">
            Most businesses don&apos;t have a lead problem. They have a <span className="font-medium text-cinder-ink">follow-through</span> problem.
          </p>
          <div className="mt-10 flex items-center gap-3.5 border-t border-cinder-line pt-6">
            <CinderMark className="h-8 w-8" />
            <p className="text-lg font-semibold tracking-[-0.015em]">Cinder connects the pieces.</p>
          </div>
        </div>

        <Reveal>
          <ol aria-label="Where revenue is won or lost" className="relative rounded-2xl border border-cinder-line bg-cinder-canvas/60 p-2 sm:p-3">
            {STAGES.map((stage, i) => (
              <li key={stage.key} className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 rounded-xl px-3 py-4 sm:grid-cols-[44px_minmax(0,1fr)_minmax(0,0.9fr)] sm:items-center sm:gap-x-6 sm:px-4 sm:py-5">
                {i < STAGES.length - 1 ? <span aria-hidden className="absolute left-[33px] top-[calc(50%+16px)] h-[calc(100%-32px)] w-px bg-cinder-line-strong sm:left-[37px]" /> : null}
                <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-cinder-surface font-mono text-[11px] font-medium text-cinder-ink-2 ring-1 ring-cinder-line-strong">{String(i + 1).padStart(2, "0")}</span>
                <span>
                  <span className="block text-[17px] font-semibold tracking-[-0.015em]">{stage.label}</span>
                  <span className="mt-0.5 block text-[15px] text-cinder-ink-2">{stage.question}</span>
                </span>
                <span className="col-start-2 mt-2 flex items-start gap-2 text-sm text-cinder-ink-3 sm:col-start-3 sm:mt-0">
                  <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-cinder-accent" />
                  <span>
                    <span className="sr-only">Where it leaks: </span>
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
// The Cinder system
// ---------------------------------------------------------------------------

export function Platform() {
  return (
    <Section
      id="platform"
      eyebrow="The Cinder system"
      title="One system for the revenue journey."
      intro="Five disciplines on one connected record. Each covers a stretch of the lifecycle. Together they cover all of it."
    >
      <ul className="mt-14 grid gap-3 sm:grid-cols-2 sm:[&>li:last-child]:col-span-2 lg:grid-cols-5 lg:[&>li:last-child]:col-span-1">
        {PILLARS.map((pillar, i) => (
          <li key={pillar.key}>
            <Reveal delay={i * 70} className="h-full">
              <div className="group flex h-full flex-col rounded-2xl border border-cinder-line bg-cinder-surface p-6 transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-24px_rgba(13,21,18,0.35)]">
                <span className="font-mono text-[11.5px] text-cinder-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-4 text-[22px] font-semibold tracking-[-0.025em] sm:mt-10">{pillar.name}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-cinder-ink-2">{pillar.line}</p>
                <div className="mt-auto pt-5 sm:pt-8">
                  <div className="flex flex-wrap content-start gap-1.5 border-t border-cinder-line pt-4 sm:min-h-[62px]">
                    {pillar.stages.map((stage) => (
                      <span key={stage} className="rounded-md bg-cinder-well px-2 py-0.5 font-mono text-[11px] text-cinder-ink-2">
                        {stage}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Trackpr
// ---------------------------------------------------------------------------

export function Trackpr() {
  return (
    <Section id="trackpr" tone="surface" className="border-y border-cinder-line">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div>
          <div className="flex items-center gap-3">
            <Badge tone="neutral">
              <CinderMark className="h-3.5 w-3.5" />
              Trackpr by Cinder
            </Badge>
          </div>
          <h2 id="trackpr-title" className="mt-6 text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-[56px] lg:text-[64px]">
            Meet Trackpr.
          </h2>
          <p className="mt-4 text-balance text-[22px] font-medium leading-snug tracking-[-0.02em] text-cinder-ink-3 sm:text-[26px]">The revenue operating system for contractors.</p>
          <p className="mt-6 max-w-[460px] text-pretty text-[17px] leading-relaxed text-cinder-ink-2">
            Trackpr is the first system from Cinder. It gives contractors one place to see the business as it actually is — and what to do next.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button href={TRACKPR_HREF} arrow size="lg">
              Explore Trackpr
            </Button>
            <Button href={TRACKPR_DEMO_HREF} variant="secondary" size="lg">
              Try the interactive demo
            </Button>
          </div>
        </div>

        <ul className="grid content-start gap-x-8 sm:grid-cols-2">
          {TRACKPR_ANSWERS.map((item, i) => (
            <li key={item.question} className={`border-t border-cinder-line py-5 ${i < 2 ? "sm:border-t-0 sm:pt-0" : ""} ${i === 0 ? "border-t-0 pt-0" : ""}`}>
              <p className="text-[17px] font-semibold tracking-[-0.015em]">{item.question}</p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-cinder-ink-2">{item.detail}</p>
              <p className="mt-3 font-mono text-[11.5px] text-cinder-ink-3">{item.area}</p>
            </li>
          ))}
        </ul>
      </div>

      <Reveal className="mt-16 sm:mt-20">
        <TrackprShowcase />
      </Reveal>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Why Cinder
// ---------------------------------------------------------------------------

const WHY_PROOF: Record<string, string> = { see: "Today", act: "Needs your attention", improve: "Analytics" };

export function WhyCinder() {
  return (
    <Section
      tone="night"
      eyebrow="Why Cinder"
      title="Not another place to enter information."
      intro="A CRM stores what already happened. Cinder is built around what happens next."
    >
      <ol className="mt-16 grid gap-px overflow-hidden rounded-2xl bg-cinder-night-line md:grid-cols-3">
        {WHY.map((item, i) => (
          <li key={item.key} className="bg-cinder-night">
            <Reveal delay={i * 90} className="flex h-full flex-col p-7 sm:p-9">
              <span className="font-mono text-[11.5px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-12 text-[30px] font-semibold tracking-[-0.03em]">{item.title}</h3>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-cinder-on-night-2">{item.line}</p>
              <p className="mt-auto pt-10 font-mono text-[11.5px] text-cinder-on-night-3">
                In Trackpr: <span className="text-cinder-accent-on-night">{WHY_PROOF[item.key]}</span>
              </p>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Industries
// ---------------------------------------------------------------------------

export function Industries() {
  return (
    <Section
      id="industries"
      eyebrow="Industries"
      title="Built around the business, not the software category."
      intro="Every service business has its own revenue lifecycle. Cinder builds a system for each one — starting with the trade that runs on estimates, jobs and invoices."
    >
      <div className="mt-14 grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Reveal>
          <Card as="article" className="relative flex h-full flex-col overflow-hidden !p-8 sm:!p-10">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-accent" />
                Available now
              </Badge>
              <Badge tone="neutral">Trackpr</Badge>
            </div>
            <h3 className="mt-10 text-[34px] font-semibold tracking-[-0.03em] sm:text-[40px]">Contractors</h3>
            <p className="mt-3 max-w-[520px] text-pretty text-[17px] leading-relaxed text-cinder-ink-2">
              Trackpr is purpose-built around the contractor revenue lifecycle — from the first call to the paid invoice.
            </p>
            <ol aria-label="The contractor lifecycle in Trackpr" className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-[12px] text-cinder-ink-2">
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
          </Card>
        </Reveal>

        <Reveal delay={90}>
          <div className="flex h-full flex-col rounded-2xl border border-dashed border-cinder-line-strong p-8 sm:p-10">
            <p className="text-sm font-medium text-cinder-ink-3">Coming into focus</p>
            <p className="mt-2 text-pretty text-[17px] leading-relaxed text-cinder-ink-2">More vertical systems are coming. These are the businesses we are studying next — none is available yet.</p>
            <ul className="mt-8 divide-y divide-cinder-line border-y border-cinder-line">
              {FUTURE_VERTICALS.map((name) => (
                <li key={name} className="flex items-center gap-3 py-3.5 text-[15px] text-cinder-ink-2">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full ring-1 ring-cinder-line-strong" />
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
// Company
// ---------------------------------------------------------------------------

export function Company() {
  return (
    <Section id="company" tone="surface" className="border-t border-cinder-line">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-20">
        <div>
          <Eyebrow>Company</Eyebrow>
          <h2 id="company-title" className="mt-5 text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[44px] lg:text-[52px]">
            Cinder exists to make revenue less fragile.
          </h2>
        </div>
        <div className="lg:pt-12">
          <p className="text-pretty text-[17px] leading-relaxed text-cinder-ink-2 sm:text-lg">
            A business shouldn&apos;t need a stack of disconnected tools, spreadsheets, inboxes, reminders and manual processes to know where its revenue stands.
          </p>
          <p className="mt-4 text-pretty text-[17px] leading-relaxed text-cinder-ink sm:text-lg">Cinder builds the systems that connect those pieces.</p>
          <dl className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-cinder-line bg-cinder-line sm:grid-cols-3">
            {[
              ["Company", "Cinder Revenue Company"],
              ["First system", "Trackpr"],
              ["First vertical", "Contractors"],
            ].map(([term, value]) => (
              <div key={term} className="bg-cinder-surface px-4 py-4">
                <dt className="text-xs text-cinder-ink-3">{term}</dt>
                <dd className="mt-1 text-[15px] font-medium tracking-[-0.01em]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Final call to action
// ---------------------------------------------------------------------------

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="bg-cinder-canvas py-16 sm:py-20">
      <div className={CONTAINER}>
        <div className="relative overflow-hidden rounded-[28px] bg-cinder-night px-6 py-16 text-center text-cinder-on-night sm:px-12 sm:py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,rgba(242,240,234,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(242,240,234,0.05)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]"
          />
          <div className="relative">
            <CinderMark tone="light" className="mx-auto h-12 w-12" />
            <h2 id="cta-title" className="mx-auto mt-8 max-w-[760px] text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[52px] lg:text-[60px]">
              Turn more opportunities into revenue.
            </h2>
            <p className="mx-auto mt-5 max-w-[520px] text-pretty text-[17px] leading-relaxed text-cinder-on-night-2 sm:text-lg">
              Build a revenue system designed around how your business actually operates.
            </p>
            <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <Button href={TALK_HREF} variant="inverse" arrow size="lg">
                Talk to Cinder
              </Button>
              <Button href={TRACKPR_HREF} variant="inverse-secondary" size="lg">
                Explore Trackpr
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
