import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleConnectWebhook } from "@/lib/payments/connect-webhook";

/**
 * Phase 1C: the Stripe Connect webhook (events on contractors' connected
 * accounts). POST only; the Stripe signature, verified with
 * STRIPE_CONNECT_WEBHOOK_SECRET through the guarded payments client, is the
 * only authentication. Every rule lives in lib/payments/connect-webhook.ts.
 */
export async function POST(request: NextRequest) {
  return handleConnectWebhook(request, { createService: createServiceRoleClient });
}
