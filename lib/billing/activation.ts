import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Payment Gate V1 - the one place that ever sets payment_status to
 * 'active'. Only ever called by app/api/webhooks/stripe/route.ts with a
 * service-role client (the same client every other webhook in this
 * codebase - Twilio's, n8n's - uses for its one trusted, unauthenticated
 * write path); the database trigger added in
 * 20260921120000_organization_payment_status.sql rejects this exact write
 * from any session-authenticated connection, so this function is not
 * itself the security boundary - the trigger is. This is naturally
 * idempotent: setting an already-'active' organization to 'active' again
 * is a no-op with no other side effect, so a duplicate/replayed webhook
 * delivery for the same checkout can never double-activate or otherwise
 * corrupt state.
 */
export async function activateOrganizationPayment(service: SupabaseClient, organizationId: string): Promise<{ ok: boolean }> {
  const { error } = await service.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);

  if (error) {
    console.error("[billing] failed to activate organization payment_status", { organizationId, error: error.message });
    return { ok: false };
  }

  return { ok: true };
}
