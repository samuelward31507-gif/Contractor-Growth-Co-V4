import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleConnectReturn } from "@/lib/payments/connect-routes";
import { resolveConnectSession } from "@/lib/payments/connect-session";

/**
 * Phase 1C: where Stripe sends the contractor back after onboarding.
 * Re-reads the connected account from Stripe for the signed-in admin's own
 * organization (nothing in the URL is trusted), then returns to Settings.
 * Every rule lives in lib/payments/connect-routes.ts's handleConnectReturn.
 */
export async function GET(request: NextRequest) {
  return handleConnectReturn(request, { resolveSession: resolveConnectSession, createService: createServiceRoleClient });
}
