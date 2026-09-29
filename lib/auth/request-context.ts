import { cache } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization, type OrganizationMembership } from "./organization";

/**
 * Performance Pass B: the request-scoped user + membership lookup every
 * authenticated layout and page shares.
 *
 * React.cache() memoizes per server request only - a new request (and so a
 * new user, a new organization) always starts empty; nothing is shared
 * across requests or users. Within one request the (app) layout, the page
 * and any helper that asks get the same Supabase client and the same
 * verified user/membership, instead of each resolving them again.
 *
 * Security model (unchanged): the user comes from supabase.auth.getUser() -
 * the Auth server's verification of the session, exactly what every page
 * already called. The membership comes from getUserOrganization(), scoped
 * to that verified user id, under RLS.
 *
 * The one speed-up: the membership query no longer waits for getUser to
 * finish. The session cookie already names the user (the JWT's `sub`), so
 * the membership query starts at the same time as getUser, using that id
 * as an unverified hint. The hint is only ever used if getUser then
 * verifies the very same user id; any mismatch (a tampered or stale cookie)
 * discards the hinted result and re-runs the query with the verified id,
 * and no verified user means no membership at all. The query itself runs
 * under RLS with the session's own JWT either way.
 */

export type RequestMembership = { user: User | null; membership: OrganizationMembership | null };

/** One Supabase server client per request. */
export const getRequestSupabase = cache(createClient);

/** The unverified user id the session cookie names - a hint, never an authorization. */
export async function sessionUserIdHint(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
}

/** The logic behind getRequestMembership, taking the client as an argument so it can be unit-tested. */
export async function resolveRequestMembership(supabase: SupabaseClient, deps: { lookupMembership?: typeof getUserOrganization } = {}): Promise<RequestMembership> {
  const lookup = deps.lookupMembership ?? getUserOrganization;
  const hint = await sessionUserIdHint(supabase);
  const [userResult, hinted] = await Promise.all([supabase.auth.getUser(), hint ? lookup(supabase, hint) : Promise.resolve(null)]);
  const user = userResult.data.user ?? null;
  if (!user) return { user: null, membership: null };
  const membership = hint === user.id ? hinted : await lookup(supabase, user.id);
  return { user, membership };
}

/** The verified user and their organization membership, resolved once per request. */
export const getRequestMembership = cache(async (): Promise<RequestMembership> => resolveRequestMembership(await getRequestSupabase()));
