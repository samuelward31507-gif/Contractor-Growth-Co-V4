import { ArrowRight } from "lucide-react";
import { Container } from "../section";
import { CtaLink } from "../cta-button";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

/**
 * The hero's system-flow rail shows only the first five steps (Capture
 * through Close) - enough to read as "a real operating sequence" at a
 * glance without turning the hero into the full ten-step diagram, which
 * belongs to the Solution section and /how-it-works.
 */
const HERO_STEPS = SYSTEM_STEPS.slice(0, 5);

export function Hero() {
  return (
    <div className="relative overflow-hidden bg-slate-950">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(16,185,129,0.12),transparent)]"
      />
      <Container className="relative py-24 sm:py-28 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-400">
            Built for contractors. Managed for you.
          </p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Turn More Leads Into Booked Jobs.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-300">
            You&apos;re already paying to generate leads. Contractor Growth Co. builds and manages the system that
            makes sure those leads get answered, followed up with, qualified, and moved toward the next step.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <CtaLink href="/get-started">
              Get Your Growth System
              <ArrowRight className="h-4 w-4" aria-hidden />
            </CtaLink>
            <CtaLink href="/how-it-works" variant="secondaryDark">
              See How It Works
            </CtaLink>
          </div>
        </div>

        {/* The system, as a real sequence - not a stock photo of a hard hat. */}
        <div className="mx-auto mt-20 max-w-5xl">
          <div className="flex flex-col divide-y divide-white/10 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] sm:flex-row sm:divide-x sm:divide-y-0">
            {HERO_STEPS.map((step, index) => (
              <div key={step.key} className="flex min-w-0 flex-1 items-center gap-3 px-5 py-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{step.label}</p>
                  <p className="truncate text-xs text-slate-400">{step.shortDescription}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-center text-xs text-slate-500">
            The full sequence continues through Book, Review, Reactivate, and Track.
          </p>
        </div>
      </Container>
    </div>
  );
}
