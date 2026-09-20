import { PhoneMissed, Clock, FileX2, EyeOff, ArrowRight, type LucideIcon } from "lucide-react";
import { Section, SectionHeading } from "../section";

const LEAKS: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: PhoneMissed,
    title: "Missed calls",
    description: "Leads call while you're on a job.",
  },
  {
    icon: Clock,
    title: "Slow response",
    description: "The longer a lead waits, the easier it is for them to move on.",
  },
  {
    icon: FileX2,
    title: "No follow-up",
    description: "Estimates and inquiries go cold without consistent follow-up.",
  },
  {
    icon: EyeOff,
    title: "Lost visibility",
    description: "You don't know which opportunities are actually turning into revenue.",
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

      {/* The leak, as a diagram: a lead enters on the left, passes through
          four real friction points, and - without a system - drops out
          before becoming booked work. A fading/dashed line rather than the
          System section's solid emerald one, so the two read as opposites
          on purpose: this one is leaking, that one is connected. */}
      <div className="mt-14 overflow-x-auto rounded-2xl border border-slate-200 bg-white px-6 py-8 sm:px-10">
        <div className="flex min-w-[640px] items-center gap-2 sm:min-w-0">
          <div className="flex shrink-0 flex-col items-center gap-2 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 bg-slate-50 text-slate-500">
              <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="text-xs font-medium text-slate-500">Lead comes in</span>
          </div>

          {LEAKS.map((leak) => (
            <div key={leak.title} className="flex flex-1 items-center gap-2">
              <span aria-hidden className="h-px flex-1 border-t border-dashed border-red-300" />
              <div className="flex shrink-0 flex-col items-center gap-2 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-500">
                  <leak.icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <span className="max-w-[6.5rem] text-xs font-medium text-slate-600">{leak.title}</span>
              </div>
            </div>
          ))}

          <div className="flex flex-1 items-center gap-2">
            <span aria-hidden className="h-px flex-1 border-t border-dashed border-red-300" />
            <div className="flex shrink-0 flex-col items-center gap-2 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-red-200 bg-red-50/60 text-red-400">
                <EyeOff className="h-[18px] w-[18px] opacity-60" aria-hidden />
              </span>
              <span className="max-w-[6.5rem] text-xs font-medium text-slate-400">Lost opportunity</span>
            </div>
          </div>
        </div>
      </div>

      {/* The same four leaks, as a diagnosis rather than a feature grid -
          a left accent bar per row instead of four boxed cards. */}
      <div className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {LEAKS.map((leak) => (
          <div key={leak.title} className="flex items-start gap-4 border-l-2 border-l-red-300 px-6 py-5 sm:px-8">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500">
              <leak.icon className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-slate-900">{leak.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{leak.description}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-center text-base font-medium text-slate-900">Contractor Growth Co. closes the gaps.</p>
    </Section>
  );
}
