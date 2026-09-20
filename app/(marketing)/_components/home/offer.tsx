import { Check } from "lucide-react";
import { Section, SectionHeading } from "../section";
import { CtaLink } from "../cta-button";

const INCLUDED = [
  "Website / lead capture",
  "Lead response",
  "AI-assisted qualification",
  "Automated follow-up",
  "Appointment management",
  "Estimate follow-up",
  "Lost lead nurture",
  "Lead reactivation",
  "Reviews + referrals",
  "Trackpr",
  "Business analytics",
  "Automation monitoring",
  "Ongoing management",
];

export function Offer() {
  return (
    <Section>
      <SectionHeading eyebrow="The offer" title="Your Contractor Growth System." align="center" />

      <div className="mx-auto mt-14 max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 sm:p-10">
        <ul className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {INCLUDED.map((item) => (
            <li key={item} className="flex items-center gap-3 text-[15px] text-slate-800">
              <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              {item}
            </li>
          ))}
        </ul>

        <div className="mt-10 border-t border-slate-100 pt-8 text-center">
          <p className="text-lg font-medium text-slate-900">We build and manage the system around your business.</p>
          <div className="mt-6">
            <CtaLink href="/get-started">Get Your Growth System</CtaLink>
          </div>
        </div>
      </div>
    </Section>
  );
}
