import type { DashboardSummary } from "@/lib/dashboard/sql";
import type { BiAiMetrics } from "@/lib/bi/types";

/**
 * Today's wording, composed only from values the page already loads
 * (dashboard_summary, the conversation attention items, today's AI
 * metrics, the end-of-day counts) - no new reads, no invented figures, no
 * attribution the data doesn't support. Pure and JSX-free so every sentence is testable
 * under plain node:test. Money arrives pre-formatted from the page so each
 * figure keeps the exact formatter it has always used.
 */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Good morning/afternoon/evening" for an hour 0-23 in the organization's own timezone. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The hour in `timeZone` (falls back to UTC for an unknown or missing zone). */
export function hourInTimeZone(date: Date, timeZone: string | null): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timeZone ?? "UTC" }).format(date);
    return Number(hour) % 24;
  } catch {
    return date.getUTCHours();
  }
}

export function attentionLine(count: number): string {
  if (count === 0) return "Nothing needs you right now.";
  return `${plural(count, "thing needs", "things need")} your attention today.`;
}

/**
 * dashboard_conversation_attention (supabase/pending/dashboard_sql.sql)
 * returns at most this many awaiting_reply conversations (`rn <= 5`) - the
 * same rows the attention list renders. A count that reaches it may be
 * higher, so it is shown as "5+", never as an exact 5.
 */
export const CONVERSATION_ATTENTION_CAP = 5;

/**
 * Conversations genuinely waiting on the owner: open conversations whose
 * most recent message is from the customer - exactly the waiting-for-reply
 * rows Act II renders (not open conversations with AI turned off, which is
 * a different population).
 *
 * Phase 2-3b (C4): pass Act II's human items (decisions.attention), so a
 * conversation still inside Trackpr's 15-minute grace period is not
 * counted - the figure always matches Act II. The cap disclosure still
 * holds: at the SQL cap every waiting conversation is human (C5), so the
 * count reaches the cap and reads "5+".
 */
export function conversationsWaitingCount(humanAttentionItems: { reasonCode: string }[]): { count: number; capped: boolean } {
  const count = humanAttentionItems.filter((item) => item.reasonCode === "customer_awaiting_reply").length;
  return { count, capped: count >= CONVERSATION_ATTENTION_CAP };
}

/**
 * Phase 2-3c: the Act I line for work Trackpr is handling right now (Act
 * II's items set aside as actor "trackpr" - decisions.trackprHandling).
 * Null when there is none, so the row only renders when N > 0.
 */
export function handlingLine(trackprHandlingCount: number): string | null {
  return trackprHandlingCount > 0 ? `Trackpr is handling ${trackprHandlingCount} automatically` : null;
}

export type TodayFigure = { key: string; label: string; value: string; detail: string; href: string; tone?: "attention" };

/**
 * The three things about today the owner reads first. Every count is an
 * uncapped aggregate except conversations waiting, whose cap is disclosed.
 */
export function todayFigures(input: { leadsReceivedToday: number; appointmentsToday: number; conversationsWaiting: { count: number; capped: boolean } }): TodayFigure[] {
  const waiting = input.conversationsWaiting;
  return [
    { key: "leads", label: "New leads", value: String(input.leadsReceivedToday), detail: input.leadsReceivedToday > 0 ? "Came in today" : "None yet today", href: "/people" },
    { key: "appointments", label: "Appointments", value: String(input.appointmentsToday), detail: input.appointmentsToday > 0 ? "On the calendar today" : "Nothing booked today", href: "/schedule" },
    {
      key: "waiting",
      label: "Waiting on your reply",
      value: waiting.capped ? `${CONVERSATION_ATTENTION_CAP}+` : String(waiting.count),
      detail: waiting.count === 0 ? "No customer is waiting" : waiting.count === 1 ? "1 conversation" : waiting.capped ? `${CONVERSATION_ATTENTION_CAP} or more conversations` : `${waiting.count} conversations`,
      href: "/conversations",
      tone: waiting.count > 0 ? "attention" : undefined,
    },
  ];
}

/**
 * What Trackpr did today, from today's AI interaction metrics, as one line.
 * "Handled", never "sent" - customerAiInteractions counts the AI's work for
 * customers, before the outbound gate, and never the owner's own
 * observations reports (lib/bi/types.ts).
 */
export function handledLine(ai: Pick<BiAiMetrics, "customerAiInteractions" | "aiNeedsHumanCount">): string {
  if (ai.customerAiInteractions === 0) return "Trackpr hasn't handled any conversations yet today.";
  const handled = `Trackpr handled ${plural(ai.customerAiInteractions, "conversation", "conversations")} today`;
  return ai.aiNeedsHumanCount > 0 ? `${handled} · handed ${ai.aiNeedsHumanCount} to you.` : `${handled}.`;
}

export type PipelineStage = { key: string; label: string; value: string; detail: string; href: string; tone?: "attention" };

/**
 * Where the work stands right now - every stage is a current-state
 * aggregate from dashboard_summary (not a period funnel), so the stages are
 * comparable side by side. Each links to the page and filter that owns it.
 * Unpaid is the one money-owed figure on Today (it used to repeat as a
 * separate "Outstanding"); anything past due is its secondary detail.
 */
export function pipelineStages(
  summary: Pick<DashboardSummary, "hot_lead_count" | "quotes_out_count" | "ready_to_schedule_count" | "won_not_finished_count" | "outstanding_count" | "not_yet_invoiced_count" | "not_yet_invoiced_unknown_count">,
  values: { openLeads: string; quotesOut: string; readyToSchedule: string; inProgress: string; readyToInvoice: string; outstanding: string },
  overdue: { count: number; value: string },
): PipelineStage[] {
  return [
    { key: "leads", label: "Leads", value: values.openLeads, detail: `${summary.hot_lead_count} hot`, href: "/people?temperature=hot" },
    { key: "quotes", label: "Quoted", value: values.quotesOut, detail: plural(summary.quotes_out_count, "estimate", "estimates"), href: "/estimates?status=sent" },
    { key: "accepted", label: "Accepted", value: values.readyToSchedule, detail: `${summary.ready_to_schedule_count} to book`, href: "/estimates?status=accepted" },
    { key: "jobs", label: "In progress", value: values.inProgress, detail: plural(summary.won_not_finished_count, "job", "jobs"), href: "/jobs?status=in_progress" },
    { key: "to-invoice", label: "Ready to invoice", value: values.readyToInvoice, detail: `${plural(summary.not_yet_invoiced_count, "completed job", "completed jobs")}${summary.not_yet_invoiced_unknown_count > 0 ? ` · ${summary.not_yet_invoiced_unknown_count} with no amount` : ""}`, href: "/money?browse=jobs&status=completed" },
    overdue.count > 0
      ? { key: "unpaid", label: "Unpaid", value: values.outstanding, detail: `${overdue.value} past due · ${plural(overdue.count, "invoice", "invoices")}`, href: "/money?browse=invoices&status=overdue", tone: "attention" }
      : { key: "unpaid", label: "Unpaid", value: values.outstanding, detail: plural(summary.outstanding_count, "invoice", "invoices"), href: "/money?browse=invoices&status=sent" },
  ];
}
