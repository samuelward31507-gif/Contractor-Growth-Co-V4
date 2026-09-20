import { ArrowRight, Inbox, Zap, ListChecks, Repeat, CalendarCheck2, FileCheck2, Briefcase, Star, Share2 } from "lucide-react";
import { Container } from "../section";
import { CtaLink } from "../cta-button";
import { SystemRail, type RailStep } from "../system-rail";

/**
 * A single lead's journey through the system, told in the hero as its own
 * narrative (Lead -> ... -> Referral) rather than reusing the homepage's
 * full 11-step Attract-to-Track system list below - deliberately a
 * different, shorter framing for the first thing a visitor sees.
 */
const LEAD_JOURNEY: RailStep[] = [
  { key: "lead", label: "Lead", icon: Inbox },
  { key: "response", label: "Instant Response", icon: Zap },
  { key: "qualification", label: "Qualification", icon: ListChecks },
  { key: "follow-up", label: "Follow-Up", icon: Repeat },
  { key: "appointment", label: "Appointment", icon: CalendarCheck2 },
  { key: "estimate", label: "Estimate", icon: FileCheck2 },
  { key: "job", label: "Job", icon: Briefcase },
  { key: "review", label: "Review", icon: Star },
  { key: "referral", label: "Referral", icon: Share2 },
];

export function Hero() {
  return (
    <div className="relative overflow-hidden bg-[#0a120f]">
      {/* Restrained depth: a soft radial glow, well under the headline in
          visual weight. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(16,185,129,0.14),transparent)]"
      />

      <Container className="relative py-24 sm:py-28 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Contractor Growth Co.</p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-[64px] lg:leading-[1.05]">
            Turn More Leads
            <br />
            Into Booked Jobs.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-300">
            You&apos;re already paying to generate leads. We build and manage the system that makes sure those leads
            get answered, followed up with, qualified, booked, and tracked.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <CtaLink href="/get-started">
              Get Started
              <ArrowRight className="h-4 w-4" aria-hidden />
            </CtaLink>
            <CtaLink href="/how-it-works" variant="secondaryDark">
              See How It Works
            </CtaLink>
          </div>
        </div>

        {/* The system, as a connected sequence a lead actually moves through
            - not a stock photo, not a disconnected feature grid. */}
        <div className="mx-auto mt-20 max-w-5xl rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-10 sm:px-10">
          <SystemRail steps={LEAD_JOURNEY} tone="dark" dense />
        </div>
      </Container>
    </div>
  );
}
