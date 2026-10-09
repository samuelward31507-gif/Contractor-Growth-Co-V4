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
  organizationEmail: null,
  organizationWebsite: null,
  organizationAddress: null,
  customerName: "Sample Customer",
  customerCompany: null,
  // Sample figures only (the page is bannered as a demo); they sum to the amount above.
  details: {
    number: 1001,
    scopeOfWork: "Sample scope: remove the existing roof down to the deck, replace damaged decking as needed, and install a new architectural shingle roof with ice and water shield at the eaves and a continuous ridge vent.",
    terms: "Sample terms: this is a demonstration quote. Real quotes show the terms the contractor writes.",
    lineItems: [
      { id: "demo-1", position: 0, description: "Tear-off and disposal of existing roofing", quantity: 24, unit: "sq", unitPrice: 95 },
      { id: "demo-2", position: 1, description: "Architectural shingles, installed", quantity: 24, unit: "sq", unitPrice: 340 },
      { id: "demo-3", position: 2, description: "Ice and water shield", quantity: 6, unit: "roll", unitPrice: 110 },
      { id: "demo-4", position: 3, description: "Ridge vent", quantity: 40, unit: "lf", unitPrice: 12.5 },
      { id: "demo-5", position: 4, description: "Dumpster and haul-away", quantity: 1, unit: null, unitPrice: 800 },
    ],
    lineItemsAvailable: true,
    textFieldsAvailable: true,
  },
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
