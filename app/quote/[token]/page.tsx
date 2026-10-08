import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getEstimateByApprovalToken, markApprovalViewed, type PublicEstimate } from "@/lib/estimates/approval";
import { QuoteDocument, QuoteUnavailable, isPastExpiry } from "./_components/quote-document";

/**
 * Quote Approval Links (V1): the public, customer-facing page a follow-up
 * text links to - see lib/estimates/approval.ts for the trust model and
 * supabase/migrations/20260928052521_estimate_approval_links.sql for the
 * token. Deliberately outside the (app) route group so it never inherits
 * the authenticated layout (the exact /demo precedent), and reachable
 * logged-out via its own startsWith exemption in lib/supabase/middleware.ts.
 *
 * The service-role client here follows app/api/leads/capture/[token]'s
 * established pattern: a server-only context whose caller is authenticated
 * by resolving an unguessable database-generated token, never by session.
 * Nothing from this module is importable by client code; the only client
 * component on the page (RespondPanel) receives plain strings.
 *
 * token === "demo" renders a static sample quote with no database touch at
 * all - the same job app/demo does for the CRM: something real-looking to
 * show a prospect, clearly labeled as a sample, safe because it can never
 * collide with a real token (real tokens are 48 hex chars).
 */

export const metadata: Metadata = {
  title: "Your quote",
  robots: { index: false, follow: false },
};

const DEMO_ESTIMATE: PublicEstimate = {
  id: "demo",
  organizationId: "demo",
  title: "Roof replacement — 1140 Alki Ave SW",
  amount: 12400,
  status: "sent",
  sentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  respondedAt: null,
  expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
  organizationName: "Ridgeline Roofing",
  organizationPhone: "+12065550142",
};

export default async function QuoteApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let estimate: PublicEstimate | null;
  if (token === "demo") {
    estimate = DEMO_ESTIMATE;
  } else {
    const service = createServiceRoleClient();
    estimate = await getEstimateByApprovalToken(service, token);
    if (estimate && estimate.status === "sent") {
      await markApprovalViewed(service, estimate.id);
    }
  }

  if (!estimate) {
    return <QuoteUnavailable />;
  }

  const expired = estimate.status === "expired" || (estimate.status === "sent" && isPastExpiry(estimate));

  return <QuoteDocument estimate={estimate} token={token} expired={expired} />;
}
