import type { ReactNode } from "react";
import type { PublicEstimate } from "@/lib/estimates/approval";
import { CheckMark } from "./check-mark";
import { RespondPanel } from "./respond-panel";

/**
 * The customer-facing quote, laid out as a document rather than an app
 * card: the business's letterhead, the work, the price, then the decision.
 * Presentational only - page.tsx resolves the token and the estimate; this
 * renders exactly the fields PublicEstimate carries (no notes, no invented
 * line items, numbers, terms or company details). Each section appears only
 * when its data exists.
 */

/**
 * Phase 1A review: the customer is approving an exact figure, so cents are
 * shown whenever the quote has them ($1,234.56) and omitted when it doesn't
 * ($12,400). The app's own formatCurrency (lib/dashboard/format.ts) rounds
 * to whole dollars, which is right for dashboards and lists but would ask a
 * customer to approve a number that differs from the quoted amount.
 */
export function formatQuoteAmount(value: number): string {
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** (206) 555-0142 from an E.164 US number; anything else renders as stored. */
export function formatPhone(value: string): string {
  const match = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

export function isPastExpiry(estimate: PublicEstimate): boolean {
  return estimate.expiresAt != null && new Date(estimate.expiresAt).getTime() < Date.now();
}

const GUTTER = "px-6 sm:px-12";
const EYEBROW = "text-[11.5px] font-semibold uppercase tracking-[0.13em] text-ink-3";

/** The page frame: the warm canvas, the optional sample banner, and the white sheet. */
export function QuoteFrame({ isDemo, children }: { isDemo: boolean; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-canvas text-ink">
      {isDemo ? (
        <div className="border-b border-line bg-warning-muted">
          <p className="mx-auto max-w-[760px] px-5 py-2.5 text-center text-[13px] font-medium text-warning-text">
            Sample quote — this is a demo, no real pricing.
          </p>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[760px] px-3 pb-16 pt-5 sm:px-6 sm:pb-24 sm:pt-14">
        <article className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgba(13,21,18,0.04),0_12px_32px_-18px_rgba(13,21,18,0.12)]">
          {children}
        </article>
      </div>
    </main>
  );
}

/** A quote that can no longer be acted on, or a link that doesn't resolve. */
export function ClosedState({ heading, body }: { heading: string; body: string }) {
  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-[-0.012em] text-ink">{heading}</h2>
      <p className="mt-2 max-w-[520px] text-[15px] leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

export function QuoteUnavailable() {
  return (
    <QuoteFrame isDemo={false}>
      <div className={`${GUTTER} py-10 sm:py-12`}>
        <ClosedState
          heading="This quote link isn't available."
          body="The link may be incomplete or out of date. If you were expecting a quote, reply to the text or call the business that sent it."
        />
      </div>
    </QuoteFrame>
  );
}

function statusLabel(estimate: PublicEstimate, expired: boolean): string | null {
  if (estimate.status === "accepted") return estimate.respondedAt ? `Approved ${formatDate(estimate.respondedAt)}` : "Approved";
  if (estimate.status === "declined") return "Declined";
  if (estimate.status === "cancelled") return "Withdrawn";
  if (expired) return "Expired";
  return null;
}

export function QuoteDocument({ estimate, token, expired }: { estimate: PublicEstimate; token: string; expired: boolean }) {
  const isDemo = token === "demo";
  const open = estimate.status === "sent" && !expired;
  const phone = estimate.organizationPhone ? formatPhone(estimate.organizationPhone) : null;
  const amountLabel = estimate.amount != null ? formatQuoteAmount(estimate.amount) : null;
  const status = statusLabel(estimate, expired);
  // A long title (a full scope sentence) reads better a size down; it is also repeated in the price line.
  const longTitle = estimate.title.length > 60;
  // Inside running sentences the number must not break at its hyphen ("555-" / "0142").
  const phoneInline = phone ? phone.replace(/-/g, "\u2011") : null;

  const facts: { term: string; value: string }[] = [];
  if (estimate.sentAt) facts.push({ term: "Issued", value: formatDate(estimate.sentAt) });
  if (estimate.expiresAt) facts.push({ term: expired ? "Valid until" : "Valid through", value: formatDate(estimate.expiresAt) });
  if (status) facts.push({ term: "Status", value: status });

  return (
    <QuoteFrame isDemo={isDemo}>
      {/* Letterhead: who sent this, and the quote's own dates. */}
      <header className={`flex flex-col gap-5 border-b border-line py-6 sm:flex-row sm:items-start sm:justify-between sm:py-9 ${GUTTER}`}>
        <div className="min-w-0">
          <p className="text-[17px] font-semibold leading-tight tracking-[-0.015em] text-ink">{estimate.organizationName}</p>
          {phone ? (
            <a
              href={`tel:${estimate.organizationPhone}`}
              className="mt-1.5 inline-block rounded text-[14px] tabular-nums text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {phone}
            </a>
          ) : null}
        </div>
        {facts.length ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-[auto_auto] sm:text-right">
            {facts.map((fact) => (
              <div key={fact.term} className="contents">
                <dt className="text-ink-3">{fact.term}</dt>
                <dd className="tabular-nums text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </header>

      {/* Opening: what this quote is for. */}
      <section aria-labelledby="quote-title" className={`pt-8 sm:pt-14 ${GUTTER}`}>
        <p className={EYEBROW}>Your quote</p>
        <h1 id="quote-title" className={`mt-3 max-w-[640px] text-pretty font-display font-semibold leading-[1.12] tracking-[-0.026em] text-ink ${longTitle ? "text-[23px] sm:text-[30px]" : "text-[28px] sm:text-[38px]"}`}>
          {estimate.title}
        </h1>
      </section>

      {/* Price: the work and its amount, then the total. Only real figures - nothing derived. */}
      {amountLabel ? (
        <section aria-label="Price" className={`pt-8 sm:pt-12 ${GUTTER}`}>
          <div className={`flex items-center justify-between border-b border-line pb-3 ${EYEBROW}`}>
            <span>Description</span>
            <span>Amount</span>
          </div>
          <div className="flex items-baseline justify-between gap-6 border-b border-line py-4 sm:py-5">
            <p className="min-w-0 text-[15.5px] leading-snug text-ink">{estimate.title}</p>
            <p className="shrink-0 text-[15.5px] tabular-nums text-ink">{amountLabel}</p>
          </div>
          <div className="flex items-end justify-between gap-6 pt-5 sm:pt-6">
            <p className="pb-1.5 text-[13px] font-semibold uppercase tracking-[0.13em] text-ink">Total</p>
            <p className="font-display text-[36px] font-semibold leading-none tracking-[-0.032em] tabular-nums text-ink sm:text-[46px]">{amountLabel}</p>
          </div>
          {estimate.expiresAt && open ? (
            <p className="mt-3 text-right text-[13.5px] text-ink-3">This price is good until {formatDate(estimate.expiresAt)}.</p>
          ) : null}
        </section>
      ) : null}

      {/* The decision. */}
      <section aria-label="Your response" className={`mt-8 border-t border-line bg-canvas/45 py-7 sm:mt-14 sm:py-10 ${GUTTER}`}>
        {estimate.status === "accepted" ? (
          <div role="status">
            <p className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.012em] text-accent-text">
              <CheckMark />
              You approved this quote{estimate.respondedAt ? ` on ${formatDate(estimate.respondedAt)}` : ""}.
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{estimate.organizationName} will be in touch to schedule the work.</p>
          </div>
        ) : estimate.status === "declined" ? (
          <ClosedState
            heading="You passed on this quote."
            body={`No problem — nothing else happens from here. If you change your mind, ${phoneInline ? `call or text ${estimate.organizationName} at ${phoneInline}.` : `get back in touch with ${estimate.organizationName}.`}`}
          />
        ) : estimate.status === "cancelled" ? (
          <ClosedState heading="This quote was withdrawn." body={`${estimate.organizationName} cancelled this quote. If that's unexpected, get in touch with them directly.`} />
        ) : expired ? (
          <ClosedState
            heading="This quote has expired."
            body={`Pricing was only guaranteed until ${estimate.expiresAt ? formatDate(estimate.expiresAt) : "its expiry date"}. ${phoneInline ? `Call or text ${phoneInline} for an updated quote.` : "Get in touch for an updated quote."}`}
          />
        ) : (
          <RespondPanel token={token} organizationName={estimate.organizationName} amountLabel={amountLabel} isDemo={isDemo} />
        )}

        {phone && open ? (
          <p className="mt-7 border-t border-line pt-5 text-[14px] leading-relaxed text-ink-3">
            Questions first? Call or text {estimate.organizationName} at{" "}
            <a
              href={`tel:${estimate.organizationPhone}`}
              className="rounded font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {phone}
            </a>
          </p>
        ) : null}
      </section>
    </QuoteFrame>
  );
}

