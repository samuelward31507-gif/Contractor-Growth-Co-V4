import Link from "next/link";
import { Table, TableHeadCell, TableBody, TableRow, TableCell } from "@/lib/ui/table";
import { surfaceClass } from "@/lib/ui/surface";
import type { MoneyEntry } from "@/lib/money/snapshot";
import type { StatusTone } from "@/lib/ui/status";
import { cardClass } from "@/lib/ui/surface";

/** Nav-restructure pass: re-exported from the shared snapshot type (now also
 * consumed by Dashboard's own compact snapshot) rather than defined here -
 * this table's own props never needed the `amount` field the shared type
 * carries, but accepting the superset keeps one real type instead of two. */
export type MoneyTableEntry = MoneyEntry;

// Same fix as PeopleTable's own ROW_GRID: Next step is always a short,
// fixed-feeling verb phrase ("Follow up," "Schedule job") - giving it an
// `fr` share stretched it across most of a wide desktop viewport as dead
// space. Customer is the one genuinely variable-length column, so it's the
// only one that grows; everything else is a fixed cap.
const COLUMNS = "grid-cols-[minmax(0,1fr)_110px_180px_100px_180px]";

const TONE_ROW: Record<StatusTone, "urgent" | "warning" | "success" | "neutral"> = {
  urgent: "urgent",
  soon: "warning",
  good: "success",
  done: "neutral",
};

/**
 * Money redesign pass: the financial-table shell for each of Money's three
 * curated groups (Quotes out / Ready to schedule / Won, not finished) - the
 * brief's own `Customer | Amount | Status | Sent | Next step` example,
 * literally. Replaces each group's QueueCard grid; "feel closer to Stripe/
 * Ramp than a CRM kanban board" is the whole reason this exists instead of
 * reusing Today's own QueueRow feed - a queue reads as "things to work",
 * a table reads as "money in motion," which is the correct register here.
 */
export function MoneyEntriesTable({ entries, emptyMessage }: { entries: MoneyTableEntry[]; emptyMessage: string }) {
  if (entries.length === 0) {
    return (
      <div className={`mt-3 ${surfaceClass} px-6 py-10 text-center`}>
        <p className="text-sm text-ink-3">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={`mt-3 overflow-hidden ${cardClass}`}>
      <Table columns={COLUMNS} className="px-3 pt-3">
        <TableHeadCell>Customer</TableHeadCell>
        <TableHeadCell align="right">Amount</TableHeadCell>
        <TableHeadCell>Status</TableHeadCell>
        <TableHeadCell>Sent</TableHeadCell>
        <TableHeadCell>Next step</TableHeadCell>
      </Table>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.key} href={entry.personHref} columns={`${COLUMNS} px-3`} tone={TONE_ROW[entry.tone]}>
            <TableCell>{entry.personName}</TableCell>
            <TableCell align="right">{entry.money ?? "—"}</TableCell>
            <TableCell muted>{entry.status}</TableCell>
            <TableCell muted>{entry.age}</TableCell>
            <TableCell muted>{entry.nextStep}</TableCell>
          </TableRow>
        ))}
      </TableBody>

      <ul className="divide-y divide-line lg:hidden">
        {entries.map((entry) => (
          <li key={entry.key}>
            <Link
              href={entry.personHref}
              className="flex flex-col gap-1 px-4 py-3.5 transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-ink">{entry.personName}</span>
                {entry.money ? <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{entry.money}</span> : null}
              </span>
              <span className="text-xs text-ink-3">
                {entry.status} · {entry.age}
              </span>
              <span className="text-xs font-medium text-ink-2">{entry.nextStep}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
