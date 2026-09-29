import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleConnectRefresh } from "@/lib/payments/connect-routes";
import { resolveConnectSession } from "@/lib/payments/connect-session";

/**
 * Phase 1C: Stripe's onboarding refresh_url. When an onboarding link has
 * expired or was already used, Stripe sends the contractor here and this
 * route sends them straight back with a fresh link for their organization's
 * EXISTING connected account - it never creates an account. GET only; every
 * rule lives in lib/payments/connect-routes.ts's handleConnectRefresh.
 */
export async function GET(request: NextRequest) {
  return handleConnectRefresh(request, { resolveSession: resolveConnectSession, createService: createServiceRoleClient });
}
