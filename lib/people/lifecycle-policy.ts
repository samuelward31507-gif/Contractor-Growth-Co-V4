import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationConfig } from "@/lib/automation/settings";
import type { LifecyclePolicy } from "@/lib/lifecycle/snapshot";
import { lifecyclePolicyFrom } from "./next-step";

/**
 * Final Batch 3: the organization's lifecycle policy (dormancy days, estimate
 * follow-up window) - the same two automation configs and defaults
 * lib/lifecycle/snapshot-loader.ts reads - loaded once per page so every
 * person on it is derived under the same policy.
 */
export async function loadLifecyclePolicy(supabase: SupabaseClient, organizationId: string): Promise<LifecyclePolicy> {
  const [customerReactivation, estimateFollowup] = await Promise.all([
    getAutomationConfig(supabase, organizationId, "customer-reactivation"),
    getAutomationConfig(supabase, organizationId, "estimate-followup"),
  ]);
  return lifecyclePolicyFrom({ customerReactivation, estimateFollowup });
}
