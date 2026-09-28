"use client";

import { useState } from "react";
import { Link2, Check } from "lucide-react";
import type { EstimateStatus } from "@/lib/estimates/queries";

/**
 * Quote Approval Links (V1): surfaces the customer-facing approval URL on
 * the estimate detail page so the contractor can paste it into any channel
 * themselves (the follow-up automation is the other consumer of the same
 * link). Shown for 'sent' (the state where approval is possible) and for
 * 'accepted'/'declined' (where the link now renders the outcome - still
 * useful to reshare as a receipt). Hidden for drafts: the public page
 * treats a draft's token as nonexistent, so showing the link would hand
 * out a URL that 404s by design.
 *
 * url === null means no app base URL is configured in this environment
 * (resolveAppBaseUrl() returned null) - same graceful degradation, same
 * wording convention as settings' lead-capture-section.tsx.
 */
export function ApprovalLinkRow({ status, url }: { status: EstimateStatus; url: string | null }) {
  const [copied, setCopied] = useState(false);

  if (status === "draft" || status === "cancelled") return null;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http); the visible URL
      // below stays selectable either way.
    }
  }

  return (
    <div className="mt-4 border-t border-inset pt-4">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Customer approval link</p>
      {url ? (
        <div className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate rounded-lg bg-inset px-3 py-2 font-mono text-xs text-ink-2">{url}</p>
          <button
            type="button"
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-2"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-3">Not available in this environment yet — configure APP_BASE_URL or deploy to production.</p>
      )}
      {status === "sent" ? (
        <p className="mt-2 text-xs text-ink-3">The customer can view this quote and approve or decline it in one tap — no login.</p>
      ) : null}
    </div>
  );
}
