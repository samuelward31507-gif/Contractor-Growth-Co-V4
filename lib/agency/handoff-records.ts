/**
 * A deal-to-client handoff record (agency_client_handoffs) as the app reads
 * it: the type, the columns selected, the row mapping and the "table not on
 * this database yet" check. Shared by the Agency Command Center (which owns
 * the table and confirms handoffs) and the Founder workspace (which prepares
 * them). Moved here unchanged from lib/founder/handoff.ts so the agency
 * doesn't depend on the Founder workspace; the handoff rules themselves stay
 * in lib/founder/handoff.ts, which re-exports these.
 */
export type HandoffStatus = "prepared" | "confirmed" | "cancelled";

/** A handoff as the founder (status only) or an agency admin sees it. */
export type ClientHandoff = {
  id: string;
  dealId: string;
  status: HandoffStatus;
  clientName: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  setupFee: number;
  monthlyFee: number;
  currency: string;
  scope: string;
  preparedBy: string;
  preparedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  agencyClientId: string | null;
};

type HandoffRow = {
  id: string;
  deal_id: string;
  status: HandoffStatus;
  client_name: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  setup_fee: number | string;
  monthly_fee: number | string;
  currency: string;
  scope: string;
  prepared_by: string;
  prepared_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  agency_client_id: string | null;
};
export const HANDOFF_COLUMNS =
  "id, deal_id, status, client_name, contact_name, contact_email, contact_phone, setup_fee, monthly_fee, currency, scope, prepared_by, prepared_at, confirmed_by, confirmed_at, cancelled_by, cancelled_at, cancel_reason, agency_client_id";
export const toHandoff = (r: HandoffRow): ClientHandoff => ({
  id: r.id,
  dealId: r.deal_id,
  status: r.status,
  clientName: r.client_name,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  setupFee: Number(r.setup_fee),
  monthlyFee: Number(r.monthly_fee),
  currency: r.currency,
  scope: r.scope,
  preparedBy: r.prepared_by,
  preparedAt: r.prepared_at,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  cancelledBy: r.cancelled_by,
  cancelledAt: r.cancelled_at,
  cancelReason: r.cancel_reason,
  agencyClientId: r.agency_client_id,
});

/** 42P01 / PGRST205: the handoff tables aren't on this database yet. */
export function isMissingHandoffTable(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01" || error.code === "PGRST205" || (/agency_client/.test(error.message ?? "") && /does not exist|could not find/i.test(error.message ?? ""));
}
