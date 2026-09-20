import { ArrowRight } from "lucide-react";
import { Section, Eyebrow } from "../section";
import { CtaLink } from "../cta-button";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

export function Solution() {
  return (
    <Section id="the-system">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
        {/* Left: the section framed as a fixed, named system rather than a
            floating headline - stays put on desktop while the sequence
            scrolls past on the right. */}
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-28">
            <Eyebrow>The system</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
              One Connected System. Built Around Your Business.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">
              We connect the pieces that normally live in separate tools — your website, lead capture, customer
              communication, follow-up, scheduling, estimates, jobs, reviews, referrals, and business analytics —
              into a single sequence every opportunity moves through.
            </p>
            <div className="mt-8 hidden items-center gap-3 border-t border-slate-200 pt-6 sm:flex">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Steps</span>
              <span className="text-xs font-semibold text-emerald-700">01</span>
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-semibold text-slate-400">11</span>
            </div>
            <div className="mt-8">
              <CtaLink href="/how-it-works" variant="secondary">
                See the full methodology
                <ArrowRight className="h-4 w-4" aria-hidden />
              </CtaLink>
            </div>
          </div>
        </div>

        {/* Right: the 11-step sequence as a single connected timeline - one
            line running through every node, not a grid of disconnected
            cards - so the "system" reads as one thing with a shape rather
            than a list of features. */}
        <div className="lg:col-span-8">
          <ol className="relative">
            <span aria-hidden className="absolute left-[19px] top-2 bottom-2 w-px bg-slate-200" />
            {SYSTEM_STEPS.map((step, index) => (
              <li key={step.key} className="relative flex gap-5 pb-10 last:pb-0">
                <span
                  className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-white ${
                    index === 0
                      ? "border-emerald-500/50 bg-emerald-50 text-emerald-600"
                      : "border-slate-200 text-slate-400"
                  }`}
                >
                  <step.icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <div className="min-w-0 pt-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-slate-400">{String(index + 1).padStart(2, "0")}</span>
                    <p className="text-base font-semibold text-slate-900">{step.label}</p>
                  </div>
                  <p className="mt-1 max-w-xl text-sm leading-relaxed text-slate-600">{step.longDescription}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Section>
  );
}
