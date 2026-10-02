/**
 * Phase 3G-2b: the invoice reminder stages - one reminder in each window of
 * days past the due date, then stop. Shared by the reminder scan
 * (lib/automation/invoice-reminders.ts) and the outbound gate's live
 * re-check (lib/automation/outbound-gate.ts) so both apply the exact same
 * rule. Pure; dates are YYYY-MM-DD calendar dates in the organization's
 * timezone, so there is no clock or timezone arithmetic here.
 *
 *   stage 1   1-6 days overdue
 *   stage 7   7-13 days overdue
 *   stage 14  14-20 days overdue
 *
 * No backfill: an invoice is only ever in one window, so an earlier stage
 * whose window has passed is never sent late, and nothing is sent 21+ days
 * overdue.
 */

export type InvoiceReminderStage = 1 | 7 | 14;

export const INVOICE_REMINDER_STAGES: readonly InvoiceReminderStage[] = [1, 7, 14];

/** The last overdue day any stage covers - invoices further overdue are never reminded. */
export const INVOICE_REMINDER_MAX_DAYS_OVERDUE = 20;

/** Whole days from `dueDate` to `today` (both YYYY-MM-DD); 0 on the due date, negative before it. */
export function daysOverdue(today: string, dueDate: string): number {
  const toUtc = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(today) - toUtc(dueDate)) / 86_400_000);
}

/** The stage whose window contains `days`, or null outside every window. */
export function reminderStageFor(days: number): InvoiceReminderStage | null {
  if (days >= 1 && days <= 6) return 1;
  if (days >= 7 && days <= 13) return 7;
  if (days >= 14 && days <= INVOICE_REMINDER_MAX_DAYS_OVERDUE) return 14;
  return null;
}
