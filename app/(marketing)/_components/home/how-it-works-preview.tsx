import { ArrowRight } from "lucide-react";
import { Section, SectionHeading } from "../section";
import { CtaLink } from "../cta-button";

const JOURNEY = [
  "A lead comes in.",
  "The system captures it.",
  "The lead receives the appropriate response.",
  "The system helps qualify the opportunity.",
  "Follow-up happens automatically.",
  "Appointments and estimates stay organized.",
  "Completed jobs trigger review and referral opportunities.",
  "The business owner can see what's happening.",
];

export function HowItWorksPreview() {
  return (
    <Section tone="subtle">
      <div className="flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between">
        <div className="lg:max-w-sm">
          <SectionHeading
            eyebrow="How it works"
            title="Your Leads Shouldn't Fall Through the Cracks."
          />
          <div className="mt-8">
            <CtaLink href="/how-it-works" variant="secondary">
              See the full walkthrough
              <ArrowRight className="h-4 w-4" aria-hidden />
            </CtaLink>
          </div>
        </div>

        <ol className="flex-1 space-y-0 lg:max-w-xl">
          {JOURNEY.map((step, index) => (
            <li key={step} className="relative flex gap-4 pb-8 last:pb-0">
              {index < JOURNEY.length - 1 ? (
                <span aria-hidden className="absolute left-[15px] top-8 h-full w-px bg-slate-200" />
              ) : null}
              <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-xs font-semibold text-slate-500">
                {index + 1}
              </span>
              <p className="pt-1 text-[15px] leading-relaxed text-slate-700">{step}</p>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
