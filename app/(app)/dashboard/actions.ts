"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardBusinessMetrics } from "@/lib/dashboard/business-metrics";
import { generateBusinessInsights } from "@/lib/bi/insights";

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

  revalidatePath("/dashboard");
  return {};
}
