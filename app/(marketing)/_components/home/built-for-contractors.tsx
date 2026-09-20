import { ArrowRight, X, Check } from "lucide-react";
import { Section, SectionHeading } from "../section";

const EXAMPLES: { before: string; after: string[] }[] = [
  {
    before: "Missed call → forgotten lead → lost job",
    after: ["Missed call", "Captured opportunity", "Response", "Qualification", "Follow-up", "Booked appointment"],
  },
  {
    before: "Estimate sent → no response → forgotten",
    after: ["Estimate sent", "Scheduled follow-up", "Customer conversation", "Next step"],
  },
  {
    before: "Job completed → nothing happens",
    after: ["Job completed", "Review request", "Referral opportunity", "Customer retained"],
  },
];

export function BuiltForContractors() {
  return (
    <Section>
      <SectionHeading
        eyebrow="Built for contractors"
        title="Built Around How Contractors Actually Work."
        description="A customer calls while you're on a job. Here's what usually happens — and what happens instead."
      />

      <div className="mt-14 space-y-6">
        {EXAMPLES.map((example) => (
          <div key={example.before} className="rounded-2xl border border-slate-200 p-6 sm:p-8">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500">
                <X className="h-3.5 w-3.5" aria-hidden />
              </span>
              <p className="text-sm font-medium text-slate-500 line-through decoration-slate-300">{example.before}</p>
            </div>

            <div className="mt-5 flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <Check className="h-3.5 w-3.5" aria-hidden />
              </span>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                {example.after.map((step, index) => (
                  <span key={step} className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{step}</span>
                    {index < example.after.length - 1 ? (
                      <ArrowRight className="h-3.5 w-3.5 text-slate-300" aria-hidden />
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
