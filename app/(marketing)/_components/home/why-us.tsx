import { Check, X } from "lucide-react";
import { Section, SectionHeading } from "../section";

const TYPICAL_SOFTWARE = ["You buy it", "You configure it", "You learn it", "You connect everything", "You maintain it"];
const CGC = ["We build it", "We configure it", "We connect it", "We manage it", "You use it"];

export function WhyUs() {
  return (
    <Section tone="subtle">
      <SectionHeading
        eyebrow="Why contractor growth co."
        title="Not Another Software Subscription."
        description="You don't need another platform to learn, another dashboard to babysit, or another system your team has to figure out. We build it, connect it, configure it, monitor it, and manage the system around your business."
      />

      <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-400">Typical software</p>
          <ul className="mt-5 space-y-4">
            {TYPICAL_SOFTWARE.map((item) => (
              <li key={item} className="flex items-center gap-3 text-[15px] text-slate-500">
                <X className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-white p-8 ring-1 ring-emerald-100">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">Contractor Growth Co.</p>
          <ul className="mt-5 space-y-4">
            {CGC.map((item) => (
              <li key={item} className="flex items-center gap-3 text-[15px] font-medium text-slate-900">
                <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
