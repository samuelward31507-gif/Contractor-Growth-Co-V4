"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Link2 } from "lucide-react";
import { secondaryButtonSmallClass } from "@/lib/ui/form";
import type { PaymentLinkView } from "@/lib/payments/payment-link";

/**
 * Phase 1C cleanup: the invoice's public payment link, for the contractor to
 * paste into any channel themselves. Every state comes from
 * lib/payments/payment-link.ts; this component only renders it. Copying
 * touches nothing but the clipboard - no request is made.
 */
export function PaymentLinkRow({ view }: { view: PaymentLinkView }) {
  const [copied, setCopied] = useState(false);

  if (view.kind === "hidden") return null;

  async function copy() {
    if (view.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(view.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http); the visible URL
      // below stays selectable either way.
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-xs font-semibold text-ink-3">Customer payment link</p>
      {view.kind === "ready" ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-md bg-inset px-3 py-2 font-mono text-xs text-ink-2">{view.url}</p>
            <button type="button" onClick={copy} className={`${secondaryButtonSmallClass} shrink-0`}>
              {copied ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy payment link"}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3" aria-live="polite">
            {copied ? "Payment link copied to your clipboard." : "The customer can pay the balance by card from this link — no login."}
          </p>
        </>
      ) : view.kind === "not_accepting" ? (
        <p className="mt-2 text-sm text-ink-3">
          Card payments aren&apos;t available yet.{" "}
          <Link href="/settings#online-payments" className="font-medium text-ink hover:underline">
            Set up online payments
          </Link>{" "}
          to share a payment link.
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-3">Not available in this environment yet — configure APP_BASE_URL or deploy to production.</p>
      )}
    </div>
  );
}
