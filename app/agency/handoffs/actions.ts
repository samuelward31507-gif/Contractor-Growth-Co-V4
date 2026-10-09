"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAgencyAdmin } from "@/lib/agency/queries";

/**
 * Agency side of the deal-to-client handoff. Each action re-checks that the
 * caller is an agency admin with their own session (never trusting that the
 * page rendered for one), then calls the database function - which checks
 * again for itself, so a caller past this check still can't confirm or
 * cancel without being an agency admin. No service-role client is used.
 */

export type AgencyHandoffResult = { ok: true; status: "confirmed" | "duplicate" | "cancelled"; agencyClientId: string | null } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOT_AUTHORIZED: AgencyHandoffResult = { ok: false, error: "Not authorized." };

function message(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "FS404":
      return "That handoff could not be found.";
    case "FS409":
    case "FS422": {
      const text = (error.message ?? "").trim();
      return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : "That isn't possible right now.";
    }
    case "42883":
    case "PGRST202":
      return "Client handoff isn't enabled on this database yet.";
    default:
      return "We couldn't complete that. Please try again - a retry never creates a second client.";
  }
}

/**
 * Confirms a prepared handoff: creates the Agency client from the prepared
 * snapshot and marks the handoff confirmed, in one database transaction. A
 * repeated confirm returns the same client.
 */
export async function confirmClientHandoff(handoffId: string): Promise<AgencyHandoffResult> {
  if (!UUID.test(String(handoffId ?? ""))) return { ok: false, error: "That handoff could not be found." };
  const supabase = await createClient();
  if (!(await isAgencyAdmin(supabase))) return NOT_AUTHORIZED;
  const { data, error } = await supabase.rpc("agency_confirm_client_handoff", { p_handoff_id: handoffId });
  if (error) return { ok: false, error: message(error) };
  revalidatePath("/agency/handoffs");
  const r = (data ?? {}) as { status?: string; agency_client_id?: string };
  return { ok: true, status: r.status === "duplicate" ? "duplicate" : "confirmed", agencyClientId: r.agency_client_id ?? null };
}

/** Cancels a prepared handoff with a reason (kept on record). A confirmed handoff can't be cancelled. */
export async function cancelAgencyClientHandoff(handoffId: string, reason: string): Promise<AgencyHandoffResult> {
  if (!UUID.test(String(handoffId ?? ""))) return { ok: false, error: "That handoff could not be found." };
  const trimmed = String(reason ?? "").trim();
  if (!trimmed || trimmed.length > 500) return { ok: false, error: "Say why the handoff is being cancelled (up to 500 characters)." };
  const supabase = await createClient();
  if (!(await isAgencyAdmin(supabase))) return NOT_AUTHORIZED;
  const { data, error } = await supabase.rpc("cancel_client_handoff", { p_handoff_id: handoffId, p_reason: trimmed });
  if (error) return { ok: false, error: message(error) };
  revalidatePath("/agency/handoffs");
  return { ok: true, status: (data as { status?: string } | null)?.status === "duplicate" ? "duplicate" : "cancelled", agencyClientId: null };
}
