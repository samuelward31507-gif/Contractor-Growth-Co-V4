import { Section, SectionHeading } from "../section";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

export function Solution() {
  return (
    <Section>
      <SectionHeading
        eyebrow="The solution"
        title="One Growth System. Built Around Your Business."
        description="We connect the pieces that normally live in separate tools — your website, lead capture, customer communication, follow-up, scheduling, estimates, jobs, reviews, referrals, and business analytics."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {SYSTEM_STEPS.map((step, index) => (
          <div key={step.key} className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <step.icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="text-xs font-medium text-slate-400">{String(index + 1).padStart(2, "0")}</span>
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-900">{step.label}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{step.shortDescription}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
