import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Payment Gate V1 (+ Subscription Lifecycle Hardening) - the only functions
 * that ever set payment_status. Only ever called by
 * app/api/webhooks/stripe/route.ts with a service-role client (the same
 * client every other webhook in this codebase - Twilio's, n8n's - uses for
 * its one trusted, unauthenticated write path); the database trigger added
 * in 20260921120000_organization_payment_status.sql rejects this exact
 * write from any session-authenticated connection, so these functions are
 * not themselves the security boundary - the trigger is. Every transition
 * is naturally idempotent: setting an organization to a status it's already
 * at is a no-op with no other side effect, so a duplicate/replayed webhook
 * delivery can never double-apply or otherwise corrupt state - this is the
 * same property activateOrganizationPayment already had, now shared by all
 * three transitions via one underlying implementation.
 */
async function setOrganizationPaymentStatus(
  service: SupabaseClient,
  organizationId: string,
  status: "active" | "suspended" | "cancelled",
): Promise<{ ok: boolean }> {
  const { error } = await service.from("organizations").update({ payment_status: status }).eq("id", organizationId);

  if (error) {
    console.error("[billing] failed to update organization payment_status", { organizationId, status, error: error.message });
    return { ok: false };
  }

  return { ok: true };
}

export async function activateOrganizationPayment(service: SupabaseClient, organizationId: string): Promise<{ ok: boolean }> {
  return setOrganizationPaymentStatus(service, organizationId, "active");
}

/**
 * A subscription entering a non-paying state that isn't a confirmed,
 * permanent cancellation - a failed renewal still within Stripe's retry
 * window (past_due), retries exhausted but the subscription left open
 * (unpaid), an abandoned initial payment (incomplete_expired), or an
 * explicitly paused subscription (paused). 'suspended' is the existing,
 * previously-reserved-but-unused payment_status value for exactly this:
 * access should stop, but this organization may still return to 'active'
 * without re-onboarding if the underlying subscription recovers.
 */
export async function suspendOrganizationPayment(service: SupabaseClient, organizationId: string): Promise<{ ok: boolean }> {
  return setOrganizationPaymentStatus(service, organizationId, "suspended");
}

/**
 * A subscription that has actually ended - either Stripe's own
 * customer.subscription.deleted event, or customer.subscription.updated
 * reporting status: 'canceled'. Unlike 'suspended', this is not expected to
 * self-recover; a cancelled organization would need a brand new checkout.
 */
export async function cancelOrganizationPayment(service: SupabaseClient, organizationId: string): Promise<{ ok: boolean }> {
  return setOrganizationPaymentStatus(service, organizationId, "cancelled");
}
