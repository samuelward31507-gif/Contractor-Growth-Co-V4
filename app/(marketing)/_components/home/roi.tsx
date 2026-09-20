import { Gauge } from "lucide-react";
import { Section, SectionHeading } from "../section";

const METRICS = [
  { label: "Leads received", note: "Every inquiry, from every source, in one place." },
  { label: "Response time", note: "How fast a new lead actually gets a reply." },
  { label: "Qualified opportunities", note: "Which leads are worth pursuing." },
  { label: "Appointments booked", note: "What's actually getting scheduled." },
  { label: "Estimates sent", note: "What's been quoted and to whom." },
  { label: "Estimates followed up", note: "What's still open, and what's gone quiet." },
  { label: "Jobs won", note: "What turned into real, booked work." },
  { label: "Revenue generated", note: "What the pipeline is actually producing." },
  { label: "Reviews requested", note: "Who's been asked after a completed job." },
  { label: "Customers reactivated", note: "Past customers who came back." },
];

export function Roi() {
  return (
    <Section tone="subtle">
      <SectionHeading
        eyebrow="What gets measured"
        title="You Can't Fix What You Can't See."
        description="Most contractors can't answer these questions today — not because the information doesn't exist, but because it's scattered across calls, texts, and memory. Contractor Growth Co. tracks it for you, automatically."
      />

      <div className="mt-14 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Gauge className="h-4 w-4" aria-hidden />
          Tracked automatically, from lead to revenue
        </div>

        <div className="mt-6 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
          {METRICS.map((metric) => (
            <div key={metric.label} className="flex items-start gap-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              <div>
                <p className="text-[15px] font-semibold text-slate-900">{metric.label}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{metric.note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
