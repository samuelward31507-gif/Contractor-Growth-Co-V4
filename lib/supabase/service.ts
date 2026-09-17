import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client for the one trusted, server-only backend context that
 * has no Supabase Auth session to work with: the n8n callback route
 * (app/api/automation/n8n-callback), which authenticates the caller with a
 * shared secret instead of a user JWT, so there is no auth.uid() for RLS or
 * the existing Automation Core RPCs to check.
 *
 * This bypasses RLS entirely and must never be imported by client code, a
 * component, or a "use server" action - only by a route handler that has
 * already independently authenticated the request via another mechanism.
 * The key is read from a server-only environment variable (never
 * NEXT_PUBLIC_*) and is never sent to, or reachable from, the browser.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Supabase service-role client is not configured.");
  }

  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
