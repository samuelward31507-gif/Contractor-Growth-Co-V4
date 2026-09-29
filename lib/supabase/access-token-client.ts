import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 2C: a Supabase client that acts as a signed-in user from nothing but
 * that user's access token (supabase-js's `accessToken` option) - no cookies,
 * no request objects, no service role.
 *
 * For work that runs after a Server Component's response, where Next.js
 * forbids request-time APIs such as cookies() (see node_modules/next/dist/
 * docs/01-app/03-api-reference/04-functions/after.md, "In Server Components"):
 * the caller reads the session's access token during render and hands it
 * here. Every query carries the anon key plus that user's JWT, so PostgREST
 * enforces exactly the same RLS as the request's own session client
 * (auth.uid() is the same user). The client never refreshes or stores the
 * session, and supabase.auth is unavailable on it by design.
 */
export function createAccessTokenClient(accessToken: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    accessToken: async () => accessToken,
  });
}
