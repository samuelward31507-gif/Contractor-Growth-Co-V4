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

/**
 * Phase G: batch variant of getAutomationEnabled for rendering an entire
 * automation list/detail page - one query for every automation_settings
 * row this organization has ever touched, instead of one query per catalog
 * automation. Missing from the returned map still means enabled (same
 * default as getAutomationEnabled) - callers should read it as
 * `map.get(id) ?? true`, never assume a present-but-false entry is the only
 * way to be disabled.
 */
export async function getAutomationEnabledMap(supabase: SupabaseClient, organizationId: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();

  const { data } = await supabase
    .from("automation_settings")
    .select("automation_id, enabled")
    .eq("organization_id", organizationId);

  for (const row of (data ?? []) as { automation_id: string; enabled: boolean }[]) {
    map.set(row.automation_id, row.enabled);
  }

  return map;
}

export type EnableToggleAudit = {
  action: "automation_enabled" | "automation_disabled";
  metadata: { previous_enabled: boolean; new_enabled: boolean };
};

/**
 * Phase H: the pure decision behind setAutomationEnabled's audit call,
 * extracted so it can be unit tested directly (app/(app)/automations/
 * actions.ts is a "use server" file - every export must be an async
 * function, so a plain synchronous helper has to live here instead).
 * Returns null for a no-op toggle (e.g. clicking "enable" on an automation
 * that's already enabled) - no automation_enabled/automation_disabled row
 * should ever be written for a state that didn't actually change.
 */
export function shouldAuditEnableToggle(previousEnabled: boolean, newEnabled: boolean): EnableToggleAudit | null {
  if (previousEnabled === newEnabled) return null;
  return {
    action: newEnabled ? "automation_enabled" : "automation_disabled",
    metadata: { previous_enabled: previousEnabled, new_enabled: newEnabled },
  };
}
