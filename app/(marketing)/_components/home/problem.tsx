import { PhoneMissed, Clock, FileX2, Ghost, Snowflake, EyeOff, type LucideIcon } from "lucide-react";
import { Section, SectionHeading } from "../section";

const LEAKS: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: PhoneMissed,
    title: "Missed calls",
    description: "A potential customer calls while you're on a job.",
  },
  {
    icon: Clock,
    title: "Slow response",
    description: "The lead waits while they contact another contractor.",
  },
  {
    icon: FileX2,
    title: "No follow-up",
    description: "An estimate gets sent and nobody follows up.",
  },
  {
    icon: Ghost,
    title: "Lost opportunities",
    description: "Good prospects disappear without anyone knowing why.",
  },
  {
    icon: Snowflake,
    title: "Customers go cold",
    description: "Past customers are forgotten instead of reactivated.",
  },
  {
    icon: EyeOff,
    title: "No visibility",
    description: "You can't easily see where opportunities are being lost.",
  },
];

export function Problem() {
  return (
    <Section tone="subtle">
      <SectionHeading
        eyebrow="The problem"
        title="Most Contractors Don't Have a Lead Problem."
        description="They have a lead-management problem."
      />

      <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
        {LEAKS.map((leak) => (
          <div key={leak.title} className="flex flex-col gap-3 bg-white p-7">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600">
              <leak.icon className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-base font-semibold text-slate-900">{leak.title}</p>
            <p className="text-sm leading-relaxed text-slate-600">{leak.description}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
