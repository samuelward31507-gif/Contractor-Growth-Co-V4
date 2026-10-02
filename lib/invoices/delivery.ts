import type { SupabaseClient } from "@supabase/supabase-js";
import { describePaymentLink, type PaymentLinkView } from "@/lib/payments/payment-link";
import { getOrganizationConnectStatus } from "@/lib/payments/connect";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { emitInvoiceLifecycleEvent, type EmitInvoiceLifecycleEvent } from "@/lib/automation/invoices";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { formatInvoiceNumber, formatMoney, type InvoiceStatus } from "./domain";

/**
 * Phase 3G-2a: "Send to customer" - the first customer-facing invoice
 * message. A contractor sends one SMS with the invoice's payment link to the
 * invoice's own customer; "Send again" is the same action after a previous
 * success.
 *
 * Runs entirely on the signed-in member's session client, so RLS and the
 * explicit organization filter decide what can be read and written, and the
 * database payment gate applies. Everything is re-read immediately before
 * sending: the invoice must be sent or partially paid with a balance, the
 * contact must exist with a phone and not have opted out, and the payment
 * link must be usable (describePaymentLink "ready" - the same rule the
 * contractor's copy-link row and the pay page use). Nothing is sent without
 * a usable link. The send goes through sendOutboundMessage (opt-out
 * enforced again there, message recorded) - never a raw provider call - and
 * only a successful send records invoice.delivered. Automation pause does
 * not apply: this is a person's own action, not an automation.
 *
 * Neither the payment token nor the link is ever logged or returned in an
 * error; failures are reported as a fixed reason.
 */

export type InvoiceDeliveryBlockReason =
  | "not_found"
  | "status_ineligible"
  | "settled"
  | "no_contact"
  | "no_phone"
  | "opted_out"
  | "link_not_accepting"
  | "link_unavailable";

export const DELIVERY_BLOCK_MESSAGE: Record<InvoiceDeliveryBlockReason, string> = {
  not_found: "This invoice could not be found.",
  status_ineligible: "Only a sent or partially paid invoice can be sent to the customer.",
  settled: "This invoice has no balance due.",
  no_contact: "Add a customer to this invoice's job before sending it.",
  no_phone: "Add a phone number for this customer before sending.",
  opted_out: "This customer has opted out of text messages.",
  link_not_accepting: "Connect Stripe to accept card payments before sending a payment link.",
  link_unavailable: "A payment link isn't available for this invoice right now.",
};

const SENDABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid"]);

type InvoiceRow = { id: string; number: number; status: InvoiceStatus; balance_due: number | string; due_date: string | null; contact_id: string | null; voided_at: string | null; payment_token: string | null };
type ContactRow = { id: string; phone: string | null; phone_normalized: string | null; sms_opt_out: boolean };

/** "Oct 19, 2026" for a YYYY-MM-DD calendar date - no timezone shift. */
export function formatDueDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** The approved initial-delivery wording. */
export function composeInvoiceDeliveryMessage(input: { businessName: string; invoiceNumber: number; balanceDue: number; dueDate: string | null; paymentUrl: string }): string {
  const due = input.dueDate ? ` It's due ${formatDueDate(input.dueDate)}.` : "";
  return `${input.businessName}: Invoice ${formatInvoiceNumber(input.invoiceNumber)} for ${formatMoney(input.balanceDue)} is ready.${due} Pay securely: ${input.paymentUrl} Reply STOP to opt out.`;
}

/** "•••• 0100" - enough for the contractor to recognize the number, without showing it in full. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

type Ready = { ok: true; invoice: InvoiceRow; contact: ContactRow; balanceDue: number; paymentUrl: string };
type Blocked = { ok: false; reason: InvoiceDeliveryBlockReason };

function linkBlock(view: PaymentLinkView): InvoiceDeliveryBlockReason {
  return view.kind === "not_accepting" ? "link_not_accepting" : "link_unavailable";
}

/** Re-reads the invoice, contact and payment link and decides whether a send is allowed right now. */
async function checkDeliverable(supabase: SupabaseClient, organizationId: string, invoiceId: string, context: { paymentStatus: string | null | undefined; baseUrl: string | null }): Promise<Ready | Blocked> {
  const { data: invoiceData } = await supabase
    .from("invoices")
    .select("id, number, status, balance_due, due_date, contact_id, voided_at, payment_token")
    .eq("id", invoiceId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const invoice = invoiceData as InvoiceRow | null;
  if (!invoice) return { ok: false, reason: "not_found" };
  if (!SENDABLE_STATUSES.has(invoice.status) || invoice.voided_at) return { ok: false, reason: "status_ineligible" };
  const balanceDue = Number(invoice.balance_due);
  if (!(balanceDue > 0)) return { ok: false, reason: "settled" };
  if (!invoice.contact_id) return { ok: false, reason: "no_contact" };

  const { data: contactData } = await supabase.from("contacts").select("id, phone, phone_normalized, sms_opt_out").eq("id", invoice.contact_id).eq("organization_id", organizationId).maybeSingle();
  const contact = contactData as ContactRow | null;
  if (!contact) return { ok: false, reason: "no_contact" };
  if (!(contact.phone_normalized ?? contact.phone)) return { ok: false, reason: "no_phone" };
  if (contact.sms_opt_out) return { ok: false, reason: "opted_out" };

  const connect = await getOrganizationConnectStatus(supabase, organizationId);
  const link = describePaymentLink({ invoiceStatus: invoice.status, token: invoice.payment_token, paymentStatus: context.paymentStatus, connect, baseUrl: context.baseUrl });
  if (link.kind !== "ready") return { ok: false, reason: linkBlock(link) };

  return { ok: true, invoice, contact, balanceDue, paymentUrl: link.url };
}

// ---------------------------------------------------------------------------
// Page state (the button)
// ---------------------------------------------------------------------------

export type InvoiceDeliveryState = {
  /** Null when sending is allowed right now; otherwise why not. */
  blockedReason: InvoiceDeliveryBlockReason | null;
  /** The customer's number, masked - only when there is one. */
  maskedPhone: string | null;
  /** When the latest successful "Send to customer" happened, or null if never. */
  lastDeliveredAt: string | null;
};

export async function getInvoiceDeliveryState(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  context: { paymentStatus: string | null | undefined; baseUrl: string | null },
): Promise<InvoiceDeliveryState> {
  const [check, lastDelivered] = await Promise.all([checkDeliverable(supabase, organizationId, invoiceId, context), getLastInvoiceDeliveryAt(supabase, organizationId, invoiceId)]);
  if (check.ok) return { blockedReason: null, maskedPhone: maskPhone((check.contact.phone_normalized ?? check.contact.phone)!), lastDeliveredAt: lastDelivered };
  return { blockedReason: check.reason, maskedPhone: null, lastDeliveredAt: lastDelivered };
}

/** The latest successful delivery - the newest invoice.delivered event for this invoice. */
export async function getLastInvoiceDeliveryAt(supabase: SupabaseClient, organizationId: string, invoiceId: string): Promise<string | null> {
  const { data } = await supabase
    .from("automation_events")
    .select("created_at")
    .eq("organization_id", organizationId)
    .eq("event_type", "invoice.delivered")
    .eq("entity_type", "invoice")
    .eq("entity_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export type InvoiceDeliveryResult = { ok: true; deliveredAt: string } | { ok: false; error: string };

export async function deliverInvoiceToCustomer(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  context: { paymentStatus: string | null | undefined; baseUrl: string | null; businessName: string | null },
  deps: { sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>; emitLifecycleEvent?: EmitInvoiceLifecycleEvent; now?: () => Date } = {},
): Promise<InvoiceDeliveryResult> {
  const check = await checkDeliverable(supabase, organizationId, invoiceId, context);
  if (!check.ok) return { ok: false, error: DELIVERY_BLOCK_MESSAGE[check.reason] };
  const { invoice, contact, balanceDue, paymentUrl } = check;

  const conversation = await findOrCreateOpenConversation(supabase, organizationId, contact.id, "sms");
  if (!conversation) return { ok: false, error: "We couldn't open a conversation with this customer. Please try again." };

  const body = composeInvoiceDeliveryMessage({ businessName: context.businessName?.trim() || "Your contractor", invoiceNumber: invoice.number, balanceDue, dueDate: invoice.due_date, paymentUrl });
  const send = await sendOutboundMessage(supabase, { organizationId, contactId: contact.id, conversationId: conversation.id, channel: "sms", senderType: "user", body, sendSmsFn: deps.sendSmsFn });
  if (!send.ok) {
    // The provider's own message is never surfaced (it can echo the number); opt-out raced in since the check is reported as such.
    console.error("[invoices] Send to customer failed", { organizationId, invoiceId });
    return { ok: false, error: "The text couldn't be sent. Please try again." };
  }

  await (deps.emitLifecycleEvent ?? emitInvoiceLifecycleEvent)(supabase, {
    eventType: "invoice.delivered",
    invoiceId: invoice.id,
    messageId: send.messageId,
    payload: { invoice_id: invoice.id, number: invoice.number, contact_id: contact.id, message_id: send.messageId, balance_due: balanceDue, due_date: invoice.due_date },
  });

  return { ok: true, deliveredAt: (deps.now ?? (() => new Date()))().toISOString() };
}
