"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardBusinessMetrics } from "@/lib/dashboard/business-metrics";
import { generateBusinessInsights } from "@/lib/bi/insights";
import { dismissOpportunityForOrganization, type DismissOpportunityResult } from "@/lib/opportunities/detect";

export type GenerateInsightsState = {
  error?: string;
};

/**
 * The ONLY place in the dashboard that ever calls Claude - a deliberate,
 * user-triggered action (a button click), never invoked by a plain page
 * render. See lib/dashboard/business-metrics.ts's getCachedBusinessInsights
 * for the read-only path every ordinary dashboard load uses instead. This
 * mirrors the existing Server Action pattern used throughout this app
 * (e.g. app/(app)/leads/actions.ts): resolve the caller's own organization
 * from their session, never trust a client-supplied id.
 */
export async function generateDashboardInsights(
  _prevState: GenerateInsightsState,
  _formData: FormData,
): Promise<GenerateInsightsState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const snapshot = await getDashboardBusinessMetrics(supabase, membership.organizationId);
  const result = await generateBusinessInsights(snapshot, { supabase });

  if (!result.ok) {
    // Never surface the internal error string (may reference provider/
    // validation internals) to the contractor - a short, generic message is
    // all the UI needs; the real reason still reaches server logs via
    // generateBusinessInsights' own console.error on a persistence failure.
    return { error: "We couldn't generate insights right now. Please try again shortly." };
  }

  // The observations render on Analytics (they moved there from Today).
  revalidatePath("/insights");
  return {};
}

/**
 * Pass 3 (Revenue Intelligence Foundation): the only write path for a
 * human-driven "dismissed" opportunity - see the opportunities migration's
 * own header for why "dismissed" (a human said not now) is kept distinct
 * from "resolved" (the detector found the underlying condition genuinely
 * went away). Mirrors app/(app)/automations/health-actions.ts's
 * acknowledgeIncident/resolveIncident shape (a plain `(id) => Promise<Result>`
 * action, not a useActionState form action) - the same "resolvable in
 * place" inline-button pattern the dashboard's AttentionPanel already uses
 * for human_escalation items, now reused for opportunity-backed items too.
 * Resolves the caller's own organization from their session, never trusts a
 * client-supplied organization id. The state-transition logic itself lives in
 * dismissOpportunityForOrganization (lib/opportunities/detect.ts), which
 * getOpportunityById scopes to that organization, so an id belonging to
 * another organization resolves to "not found" rather than ever being
 * updatable - RLS (opportunities_update) is the real backstop underneath
 * this, this is defense in depth.
 */
export async function dismissOpportunity(opportunityId: string): Promise<DismissOpportunityResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not authenticated" };
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    return { ok: false, error: "Not authorized" };
  }

  const result = await dismissOpportunityForOrganization(supabase, membership.organizationId, opportunityId);
  if (result.ok) {
    revalidatePath("/today");
  }
  return result;
}
