import type { SupabaseClient } from "@supabase/supabase-js";
import { canAcceptOnlinePayments, getOrganizationConnectStatus, type ConnectStatus } from "./connect";
import { PAYMENT_TOKEN_PATTERN } from "./public-invoice";

/**
 * Phase 1C cleanup: the contractor-facing "Copy payment link" on the invoice
 * detail page - the public /pay/<token> URL a contractor pastes into any
 * channel themselves. The estimate approval link's model
 * (app/(app)/estimates/[id]/_components/approval-link-row.tsx).
 *
 * Read-only by construction: it reads the invoice's existing,
 * database-generated payment_token (invoices_payment_token_guard owns it -
 * nothing here can create or rotate one), with the signed-in member's own
 * session client, so RLS and the organization filter decide who can see it.
 * No Stripe call, no Checkout Session, no write of any kind - copying a link
 * changes nothing.
 *
 * The link is offered only where the pay page can actually take a payment:
 * a sent or partially paid invoice of an organization that
 * canAcceptOnlinePayments (the same rule the pay page and Checkout use). The
 * view carries nothing but the public URL - no invoice, organization or
 * Stripe account id.
 */

export type PaymentLinkView =
  /** Draft, paid or void - or not this organization's invoice: nothing to share. */
  | { kind: "hidden" }
  /** Payable invoice, but the organization can't take card payments right now. */
  | { kind: "not_accepting" }
  /** Payable and accepting, but no app base URL is configured in this environment. */
  | { kind: "no_base_url" }
  | { kind: "ready"; url: string };

const LINKABLE_STATUSES: ReadonlySet<string> = new Set(["sent", "partially_paid"]);

/** `<origin>/pay/<token>`, or null for a malformed token or base URL. */
export function buildPaymentUrl(baseUrl: string, token: string): string | null {
  if (!PAYMENT_TOKEN_PATTERN.test(token)) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  return `${base.origin}/pay/${token}`;
}

export function describePaymentLink(input: {
  invoiceStatus: string | null | undefined;
  token: string | null | undefined;
  paymentStatus: string | null | undefined;
  connect: Pick<ConnectStatus, "accountId" | "chargesEnabled"> | null;
  baseUrl: string | null;
}): PaymentLinkView {
  if (!input.invoiceStatus || !LINKABLE_STATUSES.has(input.invoiceStatus) || !input.token) return { kind: "hidden" };
  if (!input.connect || !canAcceptOnlinePayments({ paymentStatus: input.paymentStatus, connect: input.connect })) return { kind: "not_accepting" };
  if (!input.baseUrl) return { kind: "no_base_url" };
  const url = buildPaymentUrl(input.baseUrl, input.token);
  return url ? { kind: "ready", url } : { kind: "hidden" };
}

/**
 * Loads the view for one invoice. `supabase` must be the signed-in member's
 * session client; `organizationId` and `paymentStatus` come from their
 * resolved membership, never from the request.
 */
export async function getInvoicePaymentLink(
  supabase: SupabaseClient,
  input: { organizationId: string; paymentStatus: string | null | undefined; invoiceId: string; baseUrl: string | null },
): Promise<PaymentLinkView> {
  const { data, error } = await supabase.from("invoices").select("status, payment_token").eq("id", input.invoiceId).eq("organization_id", input.organizationId).maybeSingle();
  if (error || !data) return { kind: "hidden" };
  const invoice = data as { status: string; payment_token: string | null };
  if (!LINKABLE_STATUSES.has(invoice.status)) return { kind: "hidden" };
  const connect = await getOrganizationConnectStatus(supabase, input.organizationId);
  return describePaymentLink({ invoiceStatus: invoice.status, token: invoice.payment_token, paymentStatus: input.paymentStatus, connect, baseUrl: input.baseUrl });
}
