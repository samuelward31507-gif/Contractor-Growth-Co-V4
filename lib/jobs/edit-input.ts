/**
 * Phase 1A (Close the Money Loop): the pure validation behind
 * app/(app)/jobs/actions.ts's updateJob - the only editable fields on a job
 * are title, amount, and notes. Kept free of any Next.js/Supabase import so
 * it can be unit tested directly with node:test (the Server Action itself
 * calls next/headers's cookies() and can't run outside a real request).
 *
 * Amount rules match createJob's existing acceptance (finite, non-negative)
 * and tighten two things a correction flow specifically needs: no sub-cent
 * values (jobs.amount is a plain numeric column, so "1234.567" would be
 * stored verbatim and then rendered as a rounded figure that no longer
 * matches what was typed) and no absurd magnitude (a mistyped extra digit
 * is the most common data-entry error this dialog exists to fix, not
 * introduce). An empty amount is legitimate and clears the value to null,
 * exactly like leaving it blank at creation - "unknown" stays honest, never
 * coerced to 0.
 */

export type JobEditInput = {
  title: string;
  amount: number | null;
  notes: string | null;
};

export type ParsedJobEdit = { input: JobEditInput; error?: undefined } | { input?: undefined; error: string };

/** Contracted amounts above this are treated as a typo, never stored. */
export const MAX_JOB_AMOUNT = 10_000_000;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseJobEditInput(fields: { title: unknown; amount: unknown; notes: unknown }): ParsedJobEdit {
  const title = asTrimmedString(fields.title);
  const amountRaw = asTrimmedString(fields.amount);
  const notes = asTrimmedString(fields.notes);

  if (!title) return { error: "Enter a title for this job." };
  if (title.length > 200) return { error: "Keep the title under 200 characters." };

  let amount: number | null = null;
  if (amountRaw) {
    const parsed = Number(amountRaw);
    if (!Number.isFinite(parsed)) return { error: "Enter a valid amount." };
    if (parsed < 0) return { error: "Amount cannot be negative." };
    if (parsed > MAX_JOB_AMOUNT) return { error: "Enter a realistic amount." };
    if (Math.round(parsed * 100) !== parsed * 100) return { error: "Enter the amount in dollars and cents (no more than two decimal places)." };
    amount = parsed;
  }

  return { input: { title, amount, notes: notes || null } };
}
