import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getPublicInvoiceByPaymentToken } from "@/lib/payments/public-invoice";
import { describePayPage, type PayPageNotice } from "@/lib/payments/pay-page-view";
import { PayPanel } from "./_components/pay-panel";

/**
 * Phase 1C, Step 5: the public, customer-facing page an invoice payment link
 * opens. Same shape and trust model as app/quote/[token]: outside the (app)
 * route group (no authenticated layout), reachable logged-out via its own
 * startsWith("/pay/") exemption in lib/supabase/middleware.ts, authorized
 * only by resolving the unguessable database-generated payment token with
 * the service-role client.
 *
 * Only the public projection (getPublicInvoiceByPaymentToken) reaches this
 * page - it never sees internal ids, the organization's subscription status,
 * its Stripe account, notes or any other internal field. An unknown,
 * malformed, draft or void token renders the one "not available" state.
 * Layout and styling follow the quote page; the Trackpr 2.0 redesign comes
 * after Phase 1C.
 *
 * referrer: "same-origin" keeps the token (which is in this page's URL) out
 * of the Referer header of every cross-origin request - including the
 * navigation to Stripe Checkout - while still letting the browser send this
 * app's real Origin on the same-origin "Pay now" POST. ("no-referrer" would
 * make browsers send Origin: null there, which the checkout route's strict
 * same-origin check rightly refuses.)
 */

export const metadata: Metadata = {
  title: "Pay your invoice",
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

function Notice({ notice }: { notice: PayPageNotice }) {
  const tone = notice.tone === "success" ? "bg-accent-muted text-accent-text" : notice.tone === "error" ? "bg-danger-muted text-danger-text" : "bg-inset text-ink-2";
  return (
    <p className={`mb-4 rounded-lg px-4 py-2.5 text-center text-sm font-semibold ${tone}`} role={notice.tone === "error" ? "alert" : undefined}>
      {notice.message}
    </p>
  );
}

export default async function PayInvoicePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const query = await searchParams;
  const invoice = await getPublicInvoiceByPaymentToken(createServiceRoleClient(), token);
  const view = describePayPage(invoice, query);

  if (!view.invoice) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-[-0.011em] text-ink">This payment link isn&apos;t available.</h1>
          <p className="mt-2 text-[15px] leading-normal text-ink-2">The link may be incomplete or out of date. If you were expecting an invoice, contact the business that sent it.</p>
        </div>
      </main>
    );
  }

  const details = view.invoice;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-md">
        {view.notice ? <Notice notice={view.notice} /> : null}

        <p className="text-center text-[11px] font-bold uppercase tracking-[0.09em] text-ink-3">{details.organizationName}</p>

        <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="px-6 pb-6 pt-7 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-ink-3">Invoice {details.label}</p>
            <h1 className="mx-auto mt-3 max-w-sm font-display text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-ink">{details.title}</h1>
            {view.state === "paid" ? (
              <p className="mt-4 font-display text-[44px] font-bold leading-none tracking-[-0.026em] tabular-nums text-ink">{details.totalLabel}</p>
            ) : (
              <>
                <p className="mt-4 font-display text-[44px] font-bold leading-none tracking-[-0.026em] tabular-nums text-ink">{details.balanceDueLabel}</p>
                <p className="mt-2 text-sm text-ink-3">
                  Balance due{details.amountPaidLabel ? ` (${details.amountPaidLabel} of ${details.totalLabel} already paid)` : ""}
                </p>
              </>
            )}
            {view.state !== "paid" && details.dueDateLabel ? (
              <p className={`mt-3 text-sm ${details.overdue ? "font-semibold text-danger-text" : "text-ink-3"}`}>
                {details.overdue ? `Overdue - was due ${details.dueDateLabel}` : `Due ${details.dueDateLabel}`}
              </p>
            ) : null}
          </div>

          <div className="border-t border-inset px-6 py-6">
            {view.state === "paid" ? (
              <div className="rounded-xl bg-accent-muted px-5 py-4 text-center">
                <p className="text-[15px] font-semibold text-accent-text">Paid in full{details.paidDateLabel ? ` on ${details.paidDateLabel}` : ""}. Thank you!</p>
              </div>
            ) : view.state === "payable" ? (
              <PayPanel token={token} amountLabel={details.balanceDueLabel} />
            ) : (
              <div className="rounded-xl bg-inset px-5 py-4 text-center">
                <p className="text-[15px] font-semibold text-ink-2">Online payment isn&apos;t available for this invoice.</p>
                <p className="mt-1 text-sm text-ink-3">Please contact {details.organizationName} to arrange payment.</p>
              </div>
            )}
          </div>
        </div>

        {details.organizationPhoneDisplay && view.state !== "paid" ? (
          <p className="mt-5 text-center text-sm text-ink-3">
            Questions about this invoice? Call or text {details.organizationName} at{" "}
            {details.organizationPhoneHref ? (
              <a href={details.organizationPhoneHref} className="font-semibold text-accent">
                {details.organizationPhoneDisplay}
              </a>
            ) : (
              details.organizationPhoneDisplay
            )}
          </p>
        ) : null}
      </div>
    </main>
  );
}
