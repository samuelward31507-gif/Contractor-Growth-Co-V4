import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleInvoiceCheckout } from "@/lib/payments/pay-routes";

/**
 * Phase 1C: the public pay page's "Pay now" button posts here. POST only
 * (Next.js answers any other method with 405); the request body is never
 * read. Every rule lives in lib/payments/pay-routes.ts's
 * handleInvoiceCheckout.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleInvoiceCheckout(request, token, { createService: createServiceRoleClient });
}
