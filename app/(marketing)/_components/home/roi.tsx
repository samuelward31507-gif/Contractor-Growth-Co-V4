import { Section, SectionHeading } from "../section";

export function Roi() {
  return (
    <Section tone="subtle">
      <SectionHeading
        eyebrow="The math"
        title="Small Leaks Can Become Expensive."
        align="center"
      />

      <div className="mx-auto mt-14 max-w-3xl rounded-2xl border border-slate-200 bg-white p-8 sm:p-10">
        <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
          Illustration only — not a projection of your results
        </p>

        <div className="mt-8 flex flex-col items-center justify-center gap-6 sm:flex-row sm:gap-10">
          <div className="text-center">
            <p className="text-3xl font-semibold tracking-tight text-slate-900">10</p>
            <p className="mt-1 text-sm text-slate-500">missed or unfollowed-up opportunities</p>
          </div>
          <span className="text-2xl font-light text-slate-300">×</span>
          <div className="text-center">
            <p className="text-3xl font-semibold tracking-tight text-slate-900">$X</p>
            <p className="mt-1 text-sm text-slate-500">your average job value</p>
          </div>
          <span className="text-2xl font-light text-slate-300">=</span>
          <div className="text-center">
            <p className="text-3xl font-semibold tracking-tight text-emerald-700">$10X</p>
            <p className="mt-1 text-sm text-slate-500">potential opportunity value</p>
          </div>
        </div>

        <p className="mx-auto mt-8 max-w-xl text-center text-sm leading-relaxed text-slate-600">
          The point isn&apos;t to guess how much money you&apos;re losing. It&apos;s to make the leaks visible and
          build a system around them.
        </p>
      </div>
    </Section>
  );
}
