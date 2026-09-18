import type { SupabaseClient } from "@supabase/supabase-js";

export type EstimateStatus = "draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired";

export const ESTIMATE_STATUSES: { value: EstimateStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

export type Estimate = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  amount: number | null;
  status: EstimateStatus;
  notes: string | null;
  sent_at: string | null;
  responded_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

const ESTIMATE_COLUMNS =
  "id, organization_id, contact_id, lead_id, title, amount, status, notes, sent_at, responded_at, expires_at, created_at, updated_at";

/**
 * Loads a single estimate scoped to the org. Mirrors getAppointment's
 * contract exactly: any error (invalid id, not found, wrong org) resolves
 * to null rather than throwing.
 */
export async function getEstimate(
  supabase: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Estimate | null> {
  const { data, error } = await supabase
    .from("estimates")
    .select(ESTIMATE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Estimate;
}
