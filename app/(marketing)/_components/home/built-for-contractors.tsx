import { ArrowRight } from "lucide-react";
import { Section, SectionHeading } from "../section";

const TRADES: { trade: string; situation: string; response: string[]; outcome: string }[] = [
  {
    trade: "Electrical",
    situation: "A customer calls after hours about a breaker issue.",
    response: ["Call captured", "Instant response", "Booked next-day"],
    outcome: "The after-hours call becomes a booked job instead of a voicemail.",
  },
  {
    trade: "HVAC",
    situation: "An AC inquiry comes in during a heat wave, and the phones are already full.",
    response: ["Lead captured", "Queued for follow-up", "Appointment booked"],
    outcome: "Inquiries survive the rush instead of getting lost in it.",
  },
  {
    trade: "Plumbing",
    situation: "A quote goes out for a repipe job and never gets followed up on.",
    response: ["Estimate tracked", "Automatic follow-up", "Customer re-engaged"],
    outcome: "Sent estimates turn into booked work instead of going cold.",
  },
  {
    trade: "Roofing",
    situation: "A storm-damage lead comes in through the website at 9pm.",
    response: ["Captured immediately", "Response scheduled", "Qualified & booked"],
    outcome: "After-hours leads are still opportunities in the morning.",
  },
  {
    trade: "Remodeling",
    situation: "A homeowner requests a consultation, but the crew is on-site all week.",
    response: ["Lead qualified", "Consultation scheduled", "Tracked to proposal"],
    outcome: "Long sales cycles stay organized instead of falling off track.",
  },
  {
    trade: "Painting",
    situation: "A job wraps up and the crew moves straight to the next one.",
    response: ["Job marked complete", "Review requested", "Referral opened"],
    outcome: "Every finished job creates the opening for the next one.",
  },
  {
    trade: "Landscaping",
    situation: "A seasonal customer from two years ago hasn't been contacted since.",
    response: ["Flagged for reactivation", "Reconnected", "New estimate requested"],
    outcome: "Past customers become repeat revenue instead of being forgotten.",
  },
  {
    trade: "General Contracting",
    situation: "Several bids are out, and it's unclear which ones are still warm.",
    response: ["Estimates tracked", "Follow-up reminders", "Pipeline visibility"],
    outcome: "Nothing falls through the cracks between bid and contract.",
  },
];

export function BuiltForContractors() {
  return (
    <Section id="who-its-for">
      <SectionHeading
        eyebrow="Built for contractors"
        title="Built Around How Contractors Actually Work."
        description="If your business gets calls, web inquiries, estimates, or repeat customers, there are probably opportunities sitting inside the process — here's what that looks like by trade."
      />

      <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {TRADES.map((item) => (
          <div key={item.trade} className="flex flex-col rounded-2xl border border-slate-200 p-6">
            <p className="text-[15px] font-semibold text-slate-900">{item.trade}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">{item.situation}</p>

            <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
              {item.response.map((step, index) => (
                <span key={step} className="flex items-center gap-1.5">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">{step}</span>
                  {index < item.response.length - 1 ? (
                    <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
                  ) : null}
                </span>
              ))}
            </div>

            <p className="mt-4 text-sm font-medium text-slate-900">{item.outcome}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
