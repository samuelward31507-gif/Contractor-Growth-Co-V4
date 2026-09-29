"use client";

import { useEffect, useState } from "react";

/**
 * Phase 1C, Step 5: the "Pay now" control on the public pay page. A plain
 * HTML form POST to /api/payments/[token]/checkout, which answers with a 303
 * to Stripe Checkout - it works without JavaScript. The form carries no
 * fields at all: the amount, the business and its Stripe account are all
 * decided server-side from the token (the route never reads the body). The
 * only client state disables the button after the first click so an
 * impatient double tap doesn't send a second request (Stripe's idempotency
 * key would resolve it to the same session anyway).
 */
export function PayPanel({ token, amountLabel }: { token: string; amountLabel: string }) {
  const [submitting, setSubmitting] = useState(false);

  // Coming Back from Stripe restores this page from the back-forward cache
  // with the button still disabled - re-enable it.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <form method="post" action={`/api/payments/${encodeURIComponent(token)}/checkout`} onSubmit={() => setSubmitting(true)} className="flex flex-col gap-3">
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex min-h-[56px] w-full items-center justify-center rounded-xl bg-accent px-4 text-base font-semibold text-white transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Opening secure checkout…" : `Pay now - ${amountLabel}`}
      </button>
      <p className="text-center text-xs text-ink-3">Card payment, processed securely by Stripe.</p>
    </form>
  );
}
