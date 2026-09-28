import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { respondToEstimateByToken, type ApprovalDecision } from "@/lib/estimates/approval";

/**
 * Quote Approval Links (V1): records the customer's decision on a sent
 * estimate. Same public trust model as app/api/leads/capture/[token] - the
 * unguessable approval_token IS the authorization (48 database-generated
 * hex chars; see the estimate_approval_links migration), so this route uses
 * the service-role client after resolving it and nothing else.
 *
 * No dedicated rate limit: unlike lead capture this route creates nothing -
 * it can only flip ONE already-sent estimate to accepted/declined exactly
 * once (the compare-and-swap in respondToEstimateByToken), so a flood of
 * requests against a valid token is idempotent noise, and guessing a token
 * is a 2^192 search. The demo token never reaches this route (the client
 * panel short-circuits it), and would fall through to not_found anyway.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 10 || token === "demo") {
    return NextResponse.json({ ok: false, outcome: "not_found" }, { status: 404 });
  }

  let decision: ApprovalDecision | null = null;
  try {
    const body = (await request.json()) as { decision?: unknown };
    if (body.decision === "accept" || body.decision === "decline") {
      decision = body.decision;
    }
  } catch {
    // fall through to the 400 below
  }
  if (!decision) {
    return NextResponse.json({ ok: false, error: "Invalid decision." }, { status: 400 });
  }

  const service = createServiceRoleClient();
  const outcome = await respondToEstimateByToken(service, token, decision);

  switch (outcome) {
    case "accepted":
    case "declined":
      return NextResponse.json({ ok: true, outcome });
    case "already_responded":
      return NextResponse.json({ ok: false, outcome }, { status: 409 });
    case "expired":
      return NextResponse.json({ ok: false, outcome }, { status: 410 });
    case "not_found":
    default:
      return NextResponse.json({ ok: false, outcome: "not_found" }, { status: 404 });
  }
}
