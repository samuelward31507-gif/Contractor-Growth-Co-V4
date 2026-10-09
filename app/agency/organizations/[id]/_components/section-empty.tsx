import { surfaceClass } from "@/lib/ui/surface";

/**
 * The in-card empty state for one section of the client detail page - the
 * same dashed "space reserved for this" well Money's tables use when a
 * group is empty (app/(app)/money/_components/money-entries-table.tsx),
 * sized for a SectionCard rather than a whole page (lib/ui/empty-state.tsx
 * is the page-level version). Always says what is empty and why.
 */
export function SectionEmpty({ title, description }: { title: string; description?: string }) {
  return (
    <div className={`${surfaceClass} px-5 py-8 text-center`}>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-sm text-sm text-ink-3">{description}</p> : null}
    </div>
  );
}
