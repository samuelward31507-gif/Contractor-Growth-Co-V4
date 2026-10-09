import type { SupabaseClient } from "@supabase/supabase-js";
import { HANDOFF_COLUMNS, isMissingHandoffTable, toHandoff, type ClientHandoff } from "@/lib/founder/handoff";
import { isAgencyAdmin } from "./queries";

/**
 * Agency client handoffs and the Agency clients confirmed from them
 * (supabase/pending/agency_client_handoff.sql). Read with the caller's own
 * session client: RLS lets only agency admins see agency_clients, and the
 * admin check here runs first so a non-admin gets "unauthorized", never an
 * empty list. Agency clients are the Agency's own records - not Trackpr
 * organizations (organizationId stays empty until a separate linking step)
 * and not contractor customers.
 */
export type AgencyClient = {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  setupFee: number;
  monthlyFee: number;
  currency: string;
  scope: string;
  status: "onboarding_not_started";
  organizationId: string | null;
  sourceDealId: string | null;
  sourceHandoffId: string | null;
  createdBy: string | null;
  createdAt: string;
};

type ClientRow = {
  id: string;
  name: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  setup_fee: number | string;
  monthly_fee: number | string;
  currency: string;
  scope: string;
  status: "onboarding_not_started";
  organization_id: string | null;
  source_deal_id: string | null;
  source_handoff_id: string | null;
  created_by: string | null;
  created_at: string;
};
const CLIENT_COLUMNS = "id, name, contact_name, contact_email, contact_phone, setup_fee, monthly_fee, currency, scope, status, organization_id, source_deal_id, source_handoff_id, created_by, created_at";
const toClient = (r: ClientRow): AgencyClient => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  setupFee: Number(r.setup_fee),
  monthlyFee: Number(r.monthly_fee),
  currency: r.currency,
  scope: r.scope,
  status: r.status,
  organizationId: r.organization_id,
  sourceDealId: r.source_deal_id,
  sourceHandoffId: r.source_handoff_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export const MAX_HANDOFF_ROWS = 500;

export type AgencyHandoffsResult =
  | { ok: true; available: boolean; handoffs: ClientHandoff[]; clients: AgencyClient[] }
  | { ok: false; reason: "not_agency_admin" | "load_failed" };

export async function getAgencyHandoffs(sessionSupabase: SupabaseClient): Promise<AgencyHandoffsResult> {
  if (!(await isAgencyAdmin(sessionSupabase))) return { ok: false, reason: "not_agency_admin" };
  const [handoffs, clients] = await Promise.all([
    sessionSupabase.from("agency_client_handoffs").select(HANDOFF_COLUMNS).order("prepared_at", { ascending: false }).limit(MAX_HANDOFF_ROWS),
    sessionSupabase.from("agency_clients").select(CLIENT_COLUMNS).order("created_at", { ascending: false }).limit(MAX_HANDOFF_ROWS),
  ]);
  const missing = [handoffs.error, clients.error].some((e) => e && isMissingHandoffTable(e));
  if (missing) return { ok: true, available: false, handoffs: [], clients: [] };
  if (handoffs.error || clients.error) return { ok: false, reason: "load_failed" };
  return { ok: true, available: true, handoffs: (handoffs.data as Parameters<typeof toHandoff>[0][]).map(toHandoff), clients: (clients.data as ClientRow[]).map(toClient) };
}
