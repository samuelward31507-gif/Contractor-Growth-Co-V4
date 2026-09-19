import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The sole read path for automation_settings.enabled. No row for a given
 * (organization_id, automation_id) means enabled - this table only ever
 * records an explicit override (Phase A/C design decision: no migration
 * backfill), so an organization that has never touched its automation
 * settings behaves exactly as it always has, with zero behavior change.
 * Explicitly scoped by organization_id on every call (never relies on RLS
 * alone to prevent cross-org reads), so this is safe to call with either a
 * session-scoped client (RLS additionally enforces is_org_member as
 * defense in depth) or a service-role client (webhook/cron callers, where
 * RLS does not apply at all).
 */
export async function getAutomationEnabled(
  supabase: SupabaseClient,
  organizationId: string,
  automationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("automation_settings")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("automation_id", automationId)
    .maybeSingle();

  return (data?.enabled as boolean | undefined) ?? true;
}
