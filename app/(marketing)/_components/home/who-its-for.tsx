import { Section, SectionHeading } from "../section";

const TRADES = [
  "HVAC",
  "Plumbing",
  "Electrical",
  "Roofing",
  "Remodeling",
  "Concrete",
  "Landscaping",
  "Painting",
  "Flooring",
  "Other service contractors",
];

export function WhoItsFor() {
  return (
    <Section id="who-its-for">
      <SectionHeading
        eyebrow="Who it's for"
        title="Built for Businesses That Are Already Getting Opportunities."
        description="If your business gets calls, web inquiries, estimates, or repeat customers, there are probably opportunities sitting inside the process."
      />

      <div className="mt-10 flex flex-wrap gap-3">
        {TRADES.map((trade) => (
          <span
            key={trade}
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            {trade}
          </span>
        ))}
      </div>
    </Section>
  );
}
