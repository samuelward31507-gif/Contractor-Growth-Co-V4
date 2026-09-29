import type { DashboardSummary } from "@/lib/dashboard/sql";
import type { BiAiMetrics } from "@/lib/bi/types";
import type { EndOfDaySummary } from "@/lib/briefing/queries";

/**
 * Trackpr 2.0 (step 2E): the Dashboard's wording, composed only from values
 * the page already loads (dashboard_summary, today's AI metrics, the
 * end-of-day counts) - no new reads, no invented figures, no attribution
 * the data doesn't support. Pure and JSX-free so every sentence is testable
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

export type BriefingInput = {
  leadsReceivedToday: number;
  appointmentsToday: number;
  quotesOutCount: number;
  quotesOutValue: string;
  readyToScheduleCount: number;
  overdueCount: number;
  overdueValue: string;
  conversationsWaiting: number;
};

/**
 * The owner briefing: a few plain sentences, most useful first, each only
 * when its number is non-zero. Every count here is an uncapped aggregate
 * (dashboard_summary / the end-of-day counts), never a capped sample list.
 */
export function briefingLines(input: BriefingInput): string[] {
  const lines: string[] = [];
  lines.push(input.leadsReceivedToday > 0 ? `${plural(input.leadsReceivedToday, "new lead", "new leads")} came in today.` : "No new leads have come in yet today.");
  if (input.appointmentsToday > 0) lines.push(`You have ${plural(input.appointmentsToday, "appointment", "appointments")} today.`);
  if (input.conversationsWaiting > 0) lines.push(`${plural(input.conversationsWaiting, "conversation is", "conversations are")} waiting on your reply.`);
  if (input.quotesOutCount > 0) lines.push(`${plural(input.quotesOutCount, "estimate", "estimates")} worth ${input.quotesOutValue} ${input.quotesOutCount === 1 ? "is" : "are"} waiting on a decision.`);
  if (input.readyToScheduleCount > 0) lines.push(`${plural(input.readyToScheduleCount, "accepted estimate hasn't", "accepted estimates haven't")} been scheduled yet.`);
  if (input.overdueCount > 0) lines.push(`${plural(input.overdueCount, "invoice", "invoices")} (${input.overdueValue}) ${input.overdueCount === 1 ? "is" : "are"} past due.`);
  return lines;
}

export type HandledItem = { label: string; value: number; tone: "neutral" | "attention" };

/**
 * What Trackpr did today, from today's AI interaction metrics - the only
 * automation activity this page already loads. "Messages recommended", not
 * "sent": aiOutboundInteractions counts what the AI recommended sending,
 * before the outbound gate (lib/bi/types.ts).
 */
export function handledItems(ai: Pick<BiAiMetrics, "aiInteractions" | "customerReplyAiInteractions" | "aiOutboundInteractions" | "aiNeedsHumanCount">): HandledItem[] {
  if (ai.aiInteractions === 0) return [];
  const items: HandledItem[] = [
    { label: "Conversations handled", value: ai.aiInteractions, tone: "neutral" },
    { label: "Customer replies answered", value: ai.customerReplyAiInteractions, tone: "neutral" },
    { label: "Messages recommended", value: ai.aiOutboundInteractions, tone: "neutral" },
  ];
  if (ai.aiNeedsHumanCount > 0) items.push({ label: "Handed to you", value: ai.aiNeedsHumanCount, tone: "attention" });
  return items;
}

export type ActivityItem = { label: string; value: number };

/** What happened today - the end-of-day counts, in business order. */
export function activityItems(endOfDay: Pick<EndOfDaySummary, "leadsReceived" | "appointmentsBooked" | "estimatesSent" | "jobsWonOrCompleted">): ActivityItem[] {
  return [
    { label: "Leads received", value: endOfDay.leadsReceived },
    { label: "Appointments booked", value: endOfDay.appointmentsBooked },
    { label: "Estimates sent", value: endOfDay.estimatesSent },
    { label: "Jobs won or completed", value: endOfDay.jobsWonOrCompleted },
  ];
}

export type PipelineStage = { key: string; label: string; count: number | null; value: string; detail: string; href: string };

/**
 * Where the work stands right now (short labels - five stages share one
 * row) - every stage is a current-state
 * aggregate from dashboard_summary (not a period funnel), so the stages are
 * comparable side by side. Each links to the page and filter that owns it.
 */
export function pipelineStages(
  summary: Pick<DashboardSummary, "hot_lead_count" | "quotes_out_count" | "ready_to_schedule_count" | "won_not_finished_count" | "outstanding_count">,
  values: { openLeads: string; quotesOut: string; readyToSchedule: string; inProgress: string; outstanding: string },
): PipelineStage[] {
  return [
    { key: "leads", label: "Leads", count: null, value: values.openLeads, detail: `${summary.hot_lead_count} hot`, href: "/people?temperature=hot" },
    { key: "quotes", label: "Quoted", count: summary.quotes_out_count, value: values.quotesOut, detail: plural(summary.quotes_out_count, "estimate", "estimates"), href: "/estimates?status=sent" },
    { key: "accepted", label: "Accepted", count: summary.ready_to_schedule_count, value: values.readyToSchedule, detail: `${summary.ready_to_schedule_count} to book`, href: "/estimates?status=accepted" },
    { key: "jobs", label: "In progress", count: summary.won_not_finished_count, value: values.inProgress, detail: plural(summary.won_not_finished_count, "job", "jobs"), href: "/jobs?status=in_progress" },
    { key: "invoiced", label: "Unpaid", count: summary.outstanding_count, value: values.outstanding, detail: plural(summary.outstanding_count, "invoice", "invoices"), href: "/money?browse=invoices&status=sent" },
  ];
}
