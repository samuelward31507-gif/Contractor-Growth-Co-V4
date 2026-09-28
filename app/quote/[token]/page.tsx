import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getEstimateByApprovalToken, markApprovalViewed, type PublicEstimate } from "@/lib/estimates/approval";
import { RespondPanel } from "./_components/respond-panel";

/**
 * Phase 1A review: the customer is approving an exact figure, so cents are
 * shown whenever the quote has them ($1,234.56) and omitted when it doesn't
 * ($12,400). The app's own formatCurrency (lib/dashboard/format.ts) rounds
 * to whole dollars, which is right for dashboards and lists but would ask a
 * customer to approve a number that differs from the quoted amount.
 */
function formatQuoteAmount(value: number): string {
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}

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

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** (206) 555-0142 from an E.164 US number; anything else renders as stored. */
function formatPhone(value: string): string {
  const match = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

function isPastExpiry(estimate: PublicEstimate): boolean {
  return estimate.expiresAt != null && new Date(estimate.expiresAt).getTime() < Date.now();
}

function ClosedState({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold tracking-[-0.011em] text-ink">{heading}</h2>
      <p className="mt-2 text-[15px] leading-normal text-ink-2">{body}</p>
    </div>
  );
}

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
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
        <div className="w-full max-w-md">
          <ClosedState
            heading="This quote link isn't available."
            body="The link may be incomplete or out of date. If you were expecting a quote, reply to the text or call the business that sent it."
          />
        </div>
      </main>
    );
  }

  const expired = estimate.status === "expired" || (estimate.status === "sent" && isPastExpiry(estimate));
  const phone = estimate.organizationPhone ? formatPhone(estimate.organizationPhone) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-md">
        {token === "demo" ? (
          <p className="mb-4 rounded-lg bg-warning-muted px-4 py-2.5 text-center text-sm font-semibold text-warning-text">
            Sample quote — this is a demo, no real pricing.
          </p>
        ) : null}

        <p className="text-center text-[11px] font-bold uppercase tracking-[0.09em] text-ink-3">{estimate.organizationName}</p>

        <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="px-6 pb-6 pt-7 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-ink-3">Your quote</p>
            <h1 className="mx-auto mt-3 max-w-sm font-display text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-ink">
              {estimate.title}
            </h1>
            {estimate.amount != null ? (
              <p className="mt-4 font-display text-[44px] font-bold leading-none tracking-[-0.026em] tabular-nums text-ink">
                {formatQuoteAmount(estimate.amount)}
              </p>
            ) : null}
            {estimate.sentAt ? (
              <p className="mt-3 text-sm text-ink-3">Sent {formatDate(estimate.sentAt)}</p>
            ) : null}
          </div>

          {/* Phase 1A review: no notes block here on purpose - estimates.notes
              is the contractor's internal field (labeled "Internal notes" in
              the estimate form) and is never selected for the public page. */}

          <div className="border-t border-inset px-6 py-6">
            {estimate.status === "accepted" ? (
              <div className="rounded-xl bg-accent-muted px-5 py-4 text-center">
                <p className="text-[15px] font-semibold text-accent-text">
                  You approved this quote{estimate.respondedAt ? ` on ${formatDate(estimate.respondedAt)}` : ""}.
                </p>
                <p className="mt-1 text-sm text-accent-text/80">{estimate.organizationName} will be in touch to schedule the work.</p>
              </div>
            ) : estimate.status === "declined" ? (
              <ClosedState
                heading="You passed on this quote."
                body={`No problem — nothing else happens from here. If you change your mind, ${phone ? `call or text ${estimate.organizationName} at ${phone}.` : `get back in touch with ${estimate.organizationName}.`}`}
              />
            ) : estimate.status === "cancelled" ? (
              <ClosedState heading="This quote was withdrawn." body={`${estimate.organizationName} cancelled this quote. If that's unexpected, get in touch with them directly.`} />
            ) : expired ? (
              <ClosedState
                heading="This quote has expired."
                body={`Pricing was only guaranteed until ${estimate.expiresAt ? formatDate(estimate.expiresAt) : "its expiry date"}. ${phone ? `Call or text ${phone} for an updated quote.` : "Get in touch for an updated quote."}`}
              />
            ) : (
              <RespondPanel
                token={token}
                organizationName={estimate.organizationName}
                amountLabel={estimate.amount != null ? formatQuoteAmount(estimate.amount) : null}
                isDemo={token === "demo"}
              />
            )}
          </div>
        </div>

        {phone && estimate.status === "sent" && !expired ? (
          <p className="mt-5 text-center text-sm text-ink-3">
            Questions first? Call or text {estimate.organizationName} at{" "}
            <a href={`tel:${estimate.organizationPhone}`} className="font-semibold text-accent">
              {phone}
            </a>
          </p>
        ) : null}
        {estimate.expiresAt && estimate.status === "sent" && !expired ? (
          <p className="mt-2 text-center text-xs text-ink-3">This price is good until {formatDate(estimate.expiresAt)}.</p>
        ) : null}
      </div>
    </main>
  );
}
