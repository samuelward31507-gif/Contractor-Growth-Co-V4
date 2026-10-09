import { AlertCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { getFounderContext, type FounderContext } from "@/lib/founder/access";
import { dayRange, localDateKey, monthKeyOf } from "@/lib/founder/model";

/** Every founder page re-checks access itself (defense in depth beyond the layout). */
export async function requireFounderPage(): Promise<FounderContext & { now: Date; todayKey: string; today: { start: Date; end: Date }; monthKey: string }> {
  const ctx = await getFounderContext();
  if (!ctx) notFound();
  const now = new Date();
  const todayKey = localDateKey(now, ctx.timeZone);
  return { ...ctx, now, todayKey, today: dayRange(todayKey, ctx.timeZone), monthKey: monthKeyOf(todayKey) };
}

/** A section's data couldn't be read - said plainly, never shown as "nothing here". */
export function LoadFailed({ what }: { what: string }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger-border bg-danger-muted px-4 py-3 text-sm text-danger-text">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{what} couldn&rsquo;t be loaded right now. Refresh to try again.</p>
    </div>
  );
}

/** The standing label on every MRR figure: entered by hand, not synced, not contractor revenue. */
export function ManualDataNote() {
  return <p className="text-xs text-ink-3">Entered manually in this workspace. Not synced from Stripe or any other system, and separate from your clients&rsquo; revenue in Trackpr.</p>;
}
