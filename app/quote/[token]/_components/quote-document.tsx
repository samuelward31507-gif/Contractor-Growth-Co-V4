import type { ReactNode } from "react";
import type { PublicEstimate } from "@/lib/estimates/approval";
import { CheckMark } from "./check-mark";
import { RespondPanel } from "./respond-panel";

/**
 * The customer-facing quote, laid out as a document rather than an app
 * card: the business's letterhead, the quote and the work it covers, its
 * dates and status, the price, then the decision and a way to reach the
 * business. Presentational only - page.tsx resolves the token and the
 * estimate; this renders exactly the fields PublicEstimate carries (no
 * notes, and no invented line items, numbers, terms or company details).
 * A quote has one amount, so it is shown once, as the total - never dressed
 * up as a line-item table. Each section appears only when its data exists.
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

const GUTTER = "px-6 sm:px-14";
const LABEL = "text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3";

/** The page frame: the warm canvas, the optional sample banner, and the white sheet. */
export function QuoteFrame({ isDemo, children }: { isDemo: boolean; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-canvas text-ink">
      {isDemo ? (
        <div className="border-b border-line bg-warning-muted">
          <p className="mx-auto max-w-[800px] px-5 py-2 text-center text-[12.5px] font-medium text-warning-text">
            Sample quote — this is a demo, no real pricing.
          </p>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[800px] px-3 pb-14 pt-4 sm:px-6 sm:pb-24 sm:pt-16">
        <article className="overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_1px_2px_rgba(13,21,18,0.035),0_10px_30px_-20px_rgba(13,21,18,0.14)]">
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
      <div className={`${GUTTER} py-10 sm:py-14`}>
        <p className={`mb-4 ${LABEL}`}>Quote</p>
        <ClosedState
          heading="This quote link isn't available."
          body="The link may be incomplete or out of date. If you were expecting a quote, reply to the text or call the business that sent it."
        />
      </div>
    </QuoteFrame>
  );
}

/** Where the quote stands, in the customer's terms - a quiet metadata line, never a badge. */
function quoteStatus(estimate: PublicEstimate, expired: boolean): { label: string; tone: "open" | "approved" | "closed" } {
  if (estimate.status === "accepted") return { label: estimate.respondedAt ? `Approved ${formatDate(estimate.respondedAt)}` : "Approved", tone: "approved" };
  if (estimate.status === "declined") return { label: "Declined", tone: "closed" };
  if (estimate.status === "cancelled") return { label: "Withdrawn", tone: "closed" };
  if (expired) return { label: "Expired", tone: "closed" };
  return { label: "Awaiting your response", tone: "open" };
}

export function QuoteDocument({ estimate, token, expired }: { estimate: PublicEstimate; token: string; expired: boolean }) {
  const isDemo = token === "demo";
  const open = estimate.status === "sent" && !expired;
  const phone = estimate.organizationPhone ? formatPhone(estimate.organizationPhone) : null;
  const amountLabel = estimate.amount != null ? formatQuoteAmount(estimate.amount) : null;
  const status = quoteStatus(estimate, expired);
  // A long title (a full scope sentence) reads better a size down; a very long one reads as a paragraph.
  const titleSize =
    estimate.title.length > 140
      ? "text-[19px] leading-[1.4] tracking-[-0.012em] sm:text-[23px] sm:leading-[1.35]"
      : estimate.title.length > 60
        ? "text-[22px] leading-[1.18] tracking-[-0.02em] sm:text-[28px]"
        : "text-[27px] leading-[1.14] tracking-[-0.024em] sm:text-[36px]";
  // Inside running sentences the number must not break at its hyphen ("555-" / "0142").
  const phoneInline = phone ? phone.replace(/-/g, "\u2011") : null;

  return (
    <QuoteFrame isDemo={isDemo}>
      {/* Letterhead: the sender, and how to reach them. */}
      <header className={`flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 border-b border-line py-6 sm:py-8 ${GUTTER}`}>
        <p className="min-w-0 text-[19px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[22px]">{estimate.organizationName}</p>
        {phone ? (
          <a
            href={`tel:${estimate.organizationPhone}`}
            className="rounded text-[14px] tabular-nums text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {phone}
          </a>
        ) : null}
      </header>

      {/* Opening: the quote, and the work it covers. */}
      <section aria-labelledby="quote-title" className={`pt-9 sm:pt-14 ${GUTTER}`}>
        <p className={LABEL}>Quote</p>
        <h1
          id="quote-title"
          className={`mt-3 max-w-[620px] text-pretty font-display font-semibold text-ink ${titleSize}`}
        >
          {estimate.title}
        </h1>

        {/* Document metadata: when it was issued and where it stands. */}
        <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-3 sm:mt-8 sm:flex sm:gap-x-12">
          {estimate.sentAt ? (
            <div>
              <dt className={LABEL}>Issued</dt>
              <dd className="mt-1 text-[14.5px] tabular-nums text-ink">{formatDate(estimate.sentAt)}</dd>
            </div>
          ) : null}
          <div>
            <dt className={LABEL}>Status</dt>
            <dd className="mt-1 flex items-center gap-2 text-[14.5px] text-ink">
              <span
                aria-hidden
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${status.tone === "approved" ? "bg-accent" : status.tone === "open" ? "bg-warning-text/70" : "bg-ink-4"}`}
              />
              <span className="tabular-nums">{status.label}</span>
            </dd>
          </div>
        </dl>
      </section>

      {/* Price: the quote has one amount, so it is shown once, as the total. */}
      {amountLabel ? (
        <section aria-label="Price" className={`mt-9 sm:mt-12 ${GUTTER}`}>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2 border-t border-ink/80 pt-5 sm:pt-6">
            <p className="pb-1 text-[13px] font-semibold uppercase tracking-[0.14em] text-ink">Total</p>
            <p className="font-display text-[38px] font-semibold leading-none tracking-[-0.034em] tabular-nums text-ink sm:text-[48px]">{amountLabel}</p>
          </div>
          {estimate.expiresAt && open ? (
            <p className="mt-3 text-[13.5px] text-ink-3 sm:text-right">This price is good until {formatDate(estimate.expiresAt)}.</p>
          ) : null}
        </section>
      ) : null}

      {/* The decision. */}
      <section aria-label="Your response" className={`mt-9 border-t border-line py-8 sm:mt-14 sm:py-11 ${GUTTER}`}>
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
      </section>

      {/* Contact: a person to ask, at the foot of the document. */}
      {phone && open ? (
        <footer className={`border-t border-line py-5 sm:py-6 ${GUTTER}`}>
          <p className="text-[14px] leading-relaxed text-ink-3">
            Questions first? Call or text {estimate.organizationName} at{" "}
            <a
              href={`tel:${estimate.organizationPhone}`}
              className="whitespace-nowrap rounded font-semibold text-ink underline decoration-line-strong underline-offset-[3px] transition-colors hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {phone}
            </a>
          </p>
        </footer>
      ) : null}
    </QuoteFrame>
  );
}
