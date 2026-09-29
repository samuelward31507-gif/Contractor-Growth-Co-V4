import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleConnectStart } from "@/lib/payments/connect-routes";
import { resolveConnectSession } from "@/lib/payments/connect-session";

/**
 * Phase 1C: starts (or resumes) Stripe Connect onboarding for the signed-in
 * admin's own organization - the Settings "Connect Stripe" / "Finish setup"
 * button posts here. POST only; every rule lives in
 * lib/payments/connect-routes.ts's handleConnectStart.
 */
export async function POST(request: NextRequest) {
  return handleConnectStart(request, { resolveSession: resolveConnectSession, createService: createServiceRoleClient });
}
