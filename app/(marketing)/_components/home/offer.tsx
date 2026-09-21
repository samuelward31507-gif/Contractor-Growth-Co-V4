import { Section, Eyebrow } from "../section";
import { CtaLink } from "../cta-button";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

export function Offer() {
  return (
    <Section tone="dark">
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow dark>The offer</Eyebrow>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          The Contractor Growth System.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-slate-300">
          Built around your business. Managed for you. Improved over time.
        </p>
      </div>

      <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-8 sm:p-10">
        <ul className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          {SYSTEM_STEPS.map((step) => (
            <li key={step.key} className="flex items-center gap-2.5 text-sm font-medium text-slate-200">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <step.icon className="h-3.5 w-3.5" aria-hidden />
              </span>
              {step.label}
            </li>
          ))}
        </ul>

        <div className="mt-10 border-t border-white/10 pt-8 text-center">
          <p className="text-base font-medium text-slate-200">
            We build and manage the system around your business — not another platform to configure yourself.
          </p>
          <div className="mt-6">
            <CtaLink href="/signup">Get Started</CtaLink>
          </div>
        </div>
      </div>
    </Section>
  );
}
