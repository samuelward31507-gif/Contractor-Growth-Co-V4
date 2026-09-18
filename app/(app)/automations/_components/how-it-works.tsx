/**
 * Simple connected vertical steps - no drag-and-drop builder, no editable
 * nodes. Steps come directly from the automation's catalog definition
 * (lib/automation/catalog.ts), which only lists steps that are actually
 * implemented in lib/automation/*.ts - nothing invented for this page.
 */
export function HowItWorks({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, index) => (
        <li key={step} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-[11px] font-medium text-slate-500">
              {index + 1}
            </span>
            {index < steps.length - 1 ? <span className="w-px flex-1 bg-slate-200" aria-hidden /> : null}
          </div>
          <p className="pb-4 pt-0.5 text-sm text-slate-700">{step}</p>
        </li>
      ))}
    </ol>
  );
}
