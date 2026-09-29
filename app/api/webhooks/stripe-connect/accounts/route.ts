import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleConnectAccountsWebhook } from "@/lib/payments/connect-accounts-webhook";

/**
 * Phase 1C (W2): the Accounts v2 thin-event webhook for connected-account
 * status changes. POST only; the Stripe signature (verified with
 * STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET through the guarded payments client)
 * is the only authentication. Every rule lives in
 * lib/payments/connect-accounts-webhook.ts.
 */
export async function POST(request: NextRequest) {
  return handleConnectAccountsWebhook(request, { createService: createServiceRoleClient });
}
