import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_TIMEZONE } from "./model";

/**
 * Founder Command Center access (supabase/pending/founder_command_center.sql).
 *
 * Founder access is an allow-list (public.founder_users), separate from
 * agency admins and from organization roles, and is enforced three times:
 * every /founder page and the layout resolve getFounderContext() and 404
 * without it; every server action re-resolves it; and every founder table's
 * RLS requires owner_id = auth.uid() AND is_founder(). Hiding the nav link
 * is a convenience, never the boundary.
 *
 * Any error - including the migration not being applied yet - resolves to
 * "not a founder", so the area fails closed.
 */

export async function isFounder(sessionSupabase: SupabaseClient): Promise<boolean> {
  const {
    data: { user },
  } = await sessionSupabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await sessionSupabase.rpc("is_founder");
  return !error && data === true;
}

export type FounderContext = {
  supabase: SupabaseClient;
  userId: string;
  email: string;
  timeZone: string;
};

function validTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The signed-in founder, or null for anyone else (signed out, not allow-listed, or an error). */
export const getFounderContext = cache(async (): Promise<FounderContext | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: allowed, error } = await supabase.rpc("is_founder");
  if (error || allowed !== true) return null;
  const { data: row } = await supabase.from("founder_users").select("timezone").eq("user_id", user.id).maybeSingle();
  return { supabase, userId: user.id, email: user.email ?? "", timeZone: validTimeZone((row as { timezone?: string } | null)?.timezone) };
});
