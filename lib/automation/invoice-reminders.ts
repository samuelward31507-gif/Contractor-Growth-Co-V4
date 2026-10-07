import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { getAutomationEnabled } from "./settings";
import { runDerivedTouch, CLAIMED_VERIFICATION_FAILED, type DerivedTouchAdapter, type DerivedTouchSubject } from "./touch-runtime";
import { describePaymentLink } from "@/lib/payments/payment-link";
import { getOrganizationConnectStatus } from "@/lib/payments/connect";
import { resolveAppBaseUrl, type SendSmsInput, type SendSmsResult } from "./sms";
import { calendarDateInTimeZone, formatInvoiceNumber, formatMoney } from "@/lib/invoices/domain";
import { formatDueDate } from "@/lib/invoices/delivery";
import { daysOverdue, reminderStageFor, INVOICE_REMINDER_MAX_DAYS_OVERDUE, type InvoiceReminderStage } from "@/lib/invoices/reminder-stages";

/**
 * Phase 3G-2b: automated invoice reminders. For an invoice the contractor has
 * already sent with "Send to customer" (lib/invoices/delivery.ts), one SMS
 * with the payment link at each overdue stage - 1-6, 7-13 and 14-20 days
 * past due - then nothing more (lib/invoices/reminder-stages.ts).
 *
 * Off by default (the catalog entry's defaultEnabled: false), so only
 * organizations that explicitly turned it on are scanned - and only those
 * that are live, payment active and not paused. Sends only between 9:00 and
 * 18:00 in the organization's timezone. Never within 48 hours of the latest
 * successful Send to customer, never more than one reminder per customer per
 * local day (the oldest overdue invoice goes first; the others wait for a
 * later run inside their windows), and never without a usable payment link.
 *
 * P0-B B2.7: each stage this scan selects runs the shared derived touch
 * runtime (lib/automation/touch-runtime.ts, INVOICE_REMINDER_ADAPTER): B1
 * verification of the customer, the claim (key
 * invoice.reminder:<invoice_id>:<stage> + B0's atomic execution start, gated
 * on enabled + automation_paused), then - only after the claim - a live
 * re-read of the invoice and payment link (verifyClaimed), then the outbound
 * gate (with the invoice check), the send and the minimal execution record.
 * A stage that is blocked or fails keeps its key, so it is never retried
 * (invoice reminders have no A2 retry); the next stage can still run later.
 * The scan, the hours window, the delivery quiet period, the duplicate and
 * customer-day checks and the outcome names stay here, in the producer.
 * The service-role client is the scheduled path's only client (as for every
 * other scheduled automation); every read is filtered by organization_id
 * and the gate re-verifies organization ownership of the invoice, contact,
 * conversation and execution.
 */

export const INVOICE_REMINDERS_AUTOMATION_ID = "invoice-reminders";
export const INVOICE_REMINDER_EVENT_TYPE = "invoice.reminder";
export const INVOICE_REMINDER_WORKFLOW = "invoice_reminder";
export const REMINDER_WINDOW_START_HOUR = 9;
export const REMINDER_WINDOW_END_HOUR = 18;
export const POST_DELIVERY_QUIET_MS = 48 * 60 * 60 * 1000;
const ID_BATCH = 200;

export function invoiceReminderIdempotencyKey(invoiceId: string, stage: InvoiceReminderStage): string {
  return `${INVOICE_REMINDER_EVENT_TYPE}:${invoiceId}:${stage}`;
}

/** The approved stage wording. */
export function composeInvoiceReminderMessage(input: { stage: InvoiceReminderStage; businessName: string; invoiceNumber: number; balanceDue: number; dueDate: string; paymentUrl: string }): string {
  const invoice = formatInvoiceNumber(input.invoiceNumber);
  const balance = formatMoney(input.balanceDue);
  const tail = `Pay securely: ${input.paymentUrl} Reply STOP to opt out.`;
  if (input.stage === 1) return `${input.businessName}: Invoice ${invoice} was due ${formatDueDate(input.dueDate)} and still has a balance of ${balance}. ${tail}`;
  if (input.stage === 7) return `${input.businessName}: Reminder: invoice ${invoice} is still outstanding. Balance due: ${balance}. ${tail}`;
  return `${input.businessName}: Final reminder: invoice ${invoice} is still outstanding. Balance due: ${balance}. ${tail}`;
}

/** True between 9:00 and 18:00 (exclusive) in `timeZone`. Throws RangeError on an invalid zone. */
export function isWithinReminderHours(now: Date, timeZone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= REMINDER_WINDOW_START_HOUR && hour < REMINDER_WINDOW_END_HOUR;
}

/** UTC instant of local midnight starting `localDate` in `timeZone` (within a day of DST shifts, precise enough for "today"). */
function localDayStartUtc(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(guess);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const shownAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (shownAsUtc - guess.getTime()));
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export type InvoiceReminderOutcome = {
  organizationId: string;
  invoiceId: string | null;
  outcome:
    | "outside_hours"
    | "not_delivered"
    | "recently_delivered"
    | "contact_reminded_today"
    | "duplicate"
    | "skipped_disabled"
    | "no_payment_link"
    | "blocked"
    | "sent"
    | "failed";
  stage?: InvoiceReminderStage;
  reason?: string;
};

export type InvoiceReminderRunResult = { candidates: number; sent: number; failed: number; scanFailed: boolean; outcomes: InvoiceReminderOutcome[] };

export type InvoiceReminderDeps = {
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>;
  log?: (message: string, context: Record<string, unknown>) => void;
};

type EligibleOrganization = { id: string; name: string | null; timezone: string | null; payment_status: string | null };
type CandidateInvoice = { id: string; number: number; status: string; balance_due: number | string; due_date: string; contact_id: string | null; payment_token: string | null };

async function readInBatches<T>(ids: string[], read: (batch: string[]) => Promise<{ data: unknown; error: unknown }>): Promise<{ rows: T[]; failed: boolean }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await read(ids.slice(i, i + ID_BATCH));
    if (error) return { rows: [], failed: true };
    rows.push(...((data ?? []) as T[]));
  }
  return { rows, failed: false };
}

async function paymentUrlFor(service: SupabaseClient, organization: EligibleOrganization, invoice: { status: string; payment_token: string | null }): Promise<string | null> {
  const connect = await getOrganizationConnectStatus(service, organization.id);
  const link = describePaymentLink({ invoiceStatus: invoice.status, token: invoice.payment_token, paymentStatus: organization.payment_status, connect, baseUrl: resolveAppBaseUrl() });
  return link.kind === "ready" ? link.url : null;
}

/** The fixed failure text recorded for a failed send - never the provider's error. */
export const INVOICE_REMINDER_SEND_FAILED_MESSAGE = "The invoice reminder SMS could not be sent.";
/** The blocked reason recorded when the claimed stage has no usable payment link (outcome no_payment_link). */
export const PAYMENT_LINK_UNAVAILABLE_REASON = "payment_link_unavailable";

/** One stage of one invoice, as the scan selected it. */
export type InvoiceReminderItem = { organization: EligibleOrganization; invoice: CandidateInvoice; stage: InvoiceReminderStage; today: string };
/** The invoice the message is composed from and its payment link - null until the claimed stage is verified live. */
export type InvoiceReminderFacts = { invoice: CandidateInvoice; paymentUrl: string | null };

const invoiceReminderSubject = ({ organization, invoice }: InvoiceReminderItem): DerivedTouchSubject => ({
  organizationId: organization.id,
  contactId: invoice.contact_id,
  leadId: null,
  entityType: "invoice",
  entityId: invoice.id,
});

/**
 * P0-B B2.7: invoice reminders on the shared derived touch runtime. The
 * stage's facts are only trusted after the claim: verifyClaimed re-reads
 * the invoice (organization-scoped) and its payment link, and a missing
 * invoice or link is a recorded block on the claimed stage - never composed,
 * gated or sent. The record is minimal: ids and the stage only, the fixed
 * failure message, never the message, conversation, provider ids or the
 * provider's error.
 */
export const INVOICE_REMINDER_ADAPTER: DerivedTouchAdapter<InvoiceReminderItem, InvoiceReminderFacts> = {
  identity: { automationId: INVOICE_REMINDERS_AUTOMATION_ID, eventType: INVOICE_REMINDER_EVENT_TYPE, workflowName: INVOICE_REMINDER_WORKFLOW },
  policy: {
    // The scan already selected live, payment-active, unpaused organizations; the gate re-checks payment.
    requiresActivePayment: false,
    // Window-based: a stage is only ever selected inside its own window (no backfill).
    stale: { mode: "none" },
    missingSubject: "record_blocked",
    gateChecksAutomationEnabled: true,
    senderType: "system",
    auditRecord: { shape: "minimal", failureMessage: INVOICE_REMINDER_SEND_FAILED_MESSAGE },
  },
  subject: invoiceReminderSubject,
  idempotencyKey: ({ invoice, stage }) => invoiceReminderIdempotencyKey(invoice.id, stage),
  isDue: ({ invoice, stage, today }) => reminderStageFor(daysOverdue(today, invoice.due_date)) === stage,
  dueAt: ({ invoice, stage }) => ({ anchorMs: new Date(`${invoice.due_date}T00:00:00Z`).getTime(), delayMs: stage * 24 * 60 * 60 * 1000 }),
  stillOwed: async (_service, { invoice }) => ({ owed: true, facts: { invoice, paymentUrl: null } }),
  // Ids, numbers and dates only - never the message, phone or payment link.
  payload: ({ invoice, stage, today }) => ({ invoice_id: invoice.id, number: invoice.number, contact_id: invoice.contact_id, stage, due_date: invoice.due_date, days_overdue: daysOverdue(today, invoice.due_date) }),
  compose: ({ organization, stage }, { invoice, paymentUrl }) => {
    if (!paymentUrl) throw new Error("invoice reminder: never composed without a verified payment link");
    return composeInvoiceReminderMessage({ stage, businessName: organization.name?.trim() || "Your contractor", invoiceNumber: invoice.number, balanceDue: Number(invoice.balance_due), dueDate: invoice.due_date, paymentUrl });
  },
  gateOptions: ({ stage }, { invoice }) => ({ invoiceId: invoice.id, invoiceReminderStage: stage }),
  auditFields: ({ invoice, stage }) => ({ invoice_id: invoice.id, stage }),
  // Live re-read of the CLAIMED stage - never the scan's copy.
  verifyClaimed: async (service, { organization, invoice }) => {
    const { data: live } = await service.from("invoices").select("id, number, status, balance_due, due_date, contact_id, payment_token").eq("id", invoice.id).eq("organization_id", organization.id).maybeSingle();
    const current = live as CandidateInvoice | null;
    if (!current || !current.contact_id) return { verdict: "blocked", reason: "invoice_not_found" };
    const paymentUrl = await paymentUrlFor(service, organization, current);
    if (!paymentUrl) return { verdict: "blocked", reason: PAYMENT_LINK_UNAVAILABLE_REASON };
    return { verdict: "verified", facts: { invoice: current, paymentUrl }, contactId: current.contact_id, leadId: null };
  },
};

/** Which of the old failure reasons a failed touch maps to: the send, the claimed verification, or the claim (event vs execution start). */
async function failureReason(service: SupabaseClient, item: InvoiceReminderItem, error: string): Promise<string> {
  if (error === INVOICE_REMINDER_SEND_FAILED_MESSAGE) return "sms_send_failed";
  if (error.startsWith(CLAIMED_VERIFICATION_FAILED)) return CLAIMED_VERIFICATION_FAILED;
  const { data: event } = await service.from("automation_events").select("id").eq("organization_id", item.organization.id).eq("idempotency_key", invoiceReminderIdempotencyKey(item.invoice.id, item.stage)).maybeSingle();
  return event ? "execution_not_started" : "event_not_recorded";
}

async function sendStage(service: SupabaseClient, organization: EligibleOrganization, invoice: CandidateInvoice, stage: InvoiceReminderStage, today: string, now: Date, isEnabled: (organizationId: string) => Promise<boolean>, deps: InvoiceReminderDeps): Promise<InvoiceReminderOutcome> {
  const base = { organizationId: organization.id, invoiceId: invoice.id, stage };
  const item: InvoiceReminderItem = { organization, invoice, stage, today };
  const result = await runDerivedTouch(service, INVOICE_REMINDER_ADAPTER, item, now, { isEnabled, sendSmsFn: deps.sendSmsFn });
  switch (result.status) {
    case "sent":
      return { ...base, outcome: "sent" };
    case "blocked":
      return result.reason === PAYMENT_LINK_UNAVAILABLE_REASON ? { ...base, outcome: "no_payment_link", reason: result.reason } : { ...base, outcome: "blocked", reason: result.reason };
    case "failed":
      return { ...base, outcome: "failed", reason: await failureReason(service, item, result.error) };
    case "lifecycle_failed":
      // B1 fails closed: nothing recorded, the stage stays eligible for a later run.
      return { ...base, outcome: "failed", reason: "lifecycle_snapshot_failed" };
    case "skipped_duplicate":
      return { ...base, outcome: "duplicate" };
    case "skipped_disabled":
      return { ...base, outcome: "skipped_disabled" };
    default:
      // Unreachable under this kind's policy (no payment check, always due and owed, record_blocked missing subject); never a success.
      return { ...base, outcome: "failed", reason: `unexpected_touch_status:${result.status}` };
  }
}

async function processOrganization(service: SupabaseClient, organization: EligibleOrganization, now: Date, deps: InvoiceReminderDeps): Promise<{ candidates: number; outcomes: InvoiceReminderOutcome[] }> {
  const timeZone = organization.timezone || "UTC";
  if (!isWithinReminderHours(now, timeZone)) return { candidates: 0, outcomes: [{ organizationId: organization.id, invoiceId: null, outcome: "outside_hours" }] };

  const today = calendarDateInTimeZone(now, timeZone);
  // Only invoices inside some stage window can be due: 1 to 20 days past due.
  const invoices = await readAllPages<CandidateInvoice>(() =>
    service
      .from("invoices")
      .select("id, number, status, balance_due, due_date, contact_id, payment_token")
      .eq("organization_id", organization.id)
      .in("status", ["sent", "partially_paid"])
      .gte("due_date", addDays(today, -INVOICE_REMINDER_MAX_DAYS_OVERDUE))
      .lte("due_date", addDays(today, -1))
      .order("due_date", { ascending: true })
      .order("id"),
  );
  if (invoices.failed) throw new Error("invoice scan failed");

  const candidates = invoices.rows.filter((invoice) => invoice.contact_id && Number(invoice.balance_due) > 0 && reminderStageFor(daysOverdue(today, invoice.due_date)) !== null);
  if (candidates.length === 0) return { candidates: 0, outcomes: [] };
  const ids = candidates.map((invoice) => invoice.id);

  // Latest successful Send to customer per invoice, existing stage keys, and contacts already reminded today.
  const [deliveries, existingKeys, remindedToday] = await Promise.all([
    readInBatches<{ entity_id: string; created_at: string }>(ids, (batch) =>
      Promise.resolve(service.from("automation_events").select("entity_id, created_at").eq("organization_id", organization.id).eq("event_type", "invoice.delivered").eq("entity_type", "invoice").in("entity_id", batch)),
    ),
    readInBatches<{ idempotency_key: string }>(ids, (batch) =>
      Promise.resolve(
        service
          .from("automation_events")
          .select("idempotency_key")
          .eq("organization_id", organization.id)
          .in(
            "idempotency_key",
            batch.flatMap((id) => [1, 7, 14].map((stage) => invoiceReminderIdempotencyKey(id, stage as InvoiceReminderStage))),
          ),
      ),
    ),
    readAllPages<{ payload: { contact_id?: string | null } | null }>(() =>
      service.from("automation_events").select("id, payload").eq("organization_id", organization.id).eq("event_type", INVOICE_REMINDER_EVENT_TYPE).gte("created_at", localDayStartUtc(today, timeZone).toISOString()).order("id"),
    ),
  ]);
  if (deliveries.failed || existingKeys.failed || remindedToday.failed) throw new Error("reminder history read failed");

  const latestDelivery = new Map<string, number>();
  for (const row of deliveries.rows) latestDelivery.set(row.entity_id, Math.max(latestDelivery.get(row.entity_id) ?? 0, new Date(row.created_at).getTime()));
  const keys = new Set(existingKeys.rows.map((row) => row.idempotency_key));
  // Any reminder attempt today (sent, blocked or failed) uses up that customer's day - conservative by design.
  const contactsDone = new Set(remindedToday.rows.map((row) => row.payload?.contact_id).filter((id): id is string => Boolean(id)));

  // The automation's enabled state, read at most once per organization per run (the runtime's kill switch).
  let enabled: Promise<boolean> | null = null;
  const isEnabled = (organizationId: string) => (enabled ??= getAutomationEnabled(service, organizationId, INVOICE_REMINDERS_AUTOMATION_ID));

  const outcomes: InvoiceReminderOutcome[] = [];
  // Oldest overdue first (then id) - deterministic choice when one customer has several.
  for (const invoice of candidates) {
    const stage = reminderStageFor(daysOverdue(today, invoice.due_date))!;
    const base = { organizationId: organization.id, invoiceId: invoice.id, stage };
    const deliveredAt = latestDelivery.get(invoice.id);
    if (deliveredAt === undefined) {
      outcomes.push({ ...base, outcome: "not_delivered" });
      continue;
    }
    if (now.getTime() - deliveredAt < POST_DELIVERY_QUIET_MS) {
      outcomes.push({ ...base, outcome: "recently_delivered" });
      continue;
    }
    if (keys.has(invoiceReminderIdempotencyKey(invoice.id, stage))) {
      outcomes.push({ ...base, outcome: "duplicate" });
      continue;
    }
    if (contactsDone.has(invoice.contact_id!)) {
      outcomes.push({ ...base, outcome: "contact_reminded_today" });
      continue;
    }
    contactsDone.add(invoice.contact_id!);
    outcomes.push(await sendStage(service, organization, invoice, stage, today, now, isEnabled, deps));
  }
  return { candidates: candidates.length, outcomes };
}

/** Called by app/api/automation/invoice-reminders every 15 minutes. One organization's failure never stops the others. */
export async function processInvoiceReminders(service: SupabaseClient, now: Date = new Date(), deps: InvoiceReminderDeps = {}): Promise<InvoiceReminderRunResult> {
  const log = deps.log ?? ((message, context) => console.error(message, context));

  // Off by default: only organizations with an explicit enabled row are considered at all.
  const optedIn = await readAllPages<{ organization_id: string }>(() => service.from("automation_settings").select("organization_id").eq("automation_id", INVOICE_REMINDERS_AUTOMATION_ID).eq("enabled", true).order("organization_id"));
  if (optedIn.failed) {
    log("[invoice-reminders] opted-in organization scan failed", {});
    return { candidates: 0, sent: 0, failed: 0, scanFailed: true, outcomes: [] };
  }
  const optedInIds = optedIn.rows.map((row) => row.organization_id);
  const organizations = await readInBatches<EligibleOrganization>(optedInIds, (batch) =>
    Promise.resolve(service.from("organizations").select("id, name, timezone, payment_status").in("id", batch).eq("automation_mode", "live").eq("payment_status", "active").eq("automation_paused", false).order("id")),
  );
  if (organizations.failed) {
    log("[invoice-reminders] eligible organization scan failed", {});
    return { candidates: 0, sent: 0, failed: 0, scanFailed: true, outcomes: [] };
  }

  let candidates = 0;
  const outcomes: InvoiceReminderOutcome[] = [];
  for (const organization of organizations.rows) {
    try {
      const result = await processOrganization(service, organization, now, deps);
      candidates += result.candidates;
      outcomes.push(...result.outcomes);
    } catch (error) {
      log("[invoice-reminders] run failed for an organization", { organizationId: organization.id, error: error instanceof Error ? error.name : "unknown" });
      outcomes.push({ organizationId: organization.id, invoiceId: null, outcome: "failed" });
    }
  }

  return { candidates, sent: outcomes.filter((o) => o.outcome === "sent").length, failed: outcomes.filter((o) => o.outcome === "failed").length, scanFailed: false, outcomes };
}
