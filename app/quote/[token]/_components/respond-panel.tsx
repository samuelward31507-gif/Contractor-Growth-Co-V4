"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckMark } from "./check-mark";

/**
 * The approve/decline controls for a still-open quote. Two-step on purpose:
 * the first tap arms a confirmation ("Yes, approve — $12,400"), the second
 * commits - a customer holding a phone on a job site should never approve
 * five figures with one accidental thumb. Decline is quieter and also
 * two-step. All state is local; the server's compare-and-swap (see
 * lib/estimates/approval.ts) is what actually guarantees single-fire.
 *
 * In demo mode (the /quote/demo sample) the panel walks through the same
 * states without calling the API, so a prospect can feel the flow without
 * writing anywhere.
 */
export function RespondPanel({
  token,
  organizationName,
  amountLabel,
  isDemo,
}: {
  token: string;
  organizationName: string;
  amountLabel: string | null;
  isDemo: boolean;
}) {
  const router = useRouter();
  const [arming, setArming] = useState<"accept" | "decline" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: "accept" | "decline") {
    setSubmitting(true);
    setError(null);
    try {
      if (isDemo) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        setDone(decision === "accept" ? "accepted" : "declined");
        return;
      }
      const response = await fetch(`/api/quote/${encodeURIComponent(token)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; outcome?: string } | null;
      if (response.ok && payload?.ok && (payload.outcome === "accepted" || payload.outcome === "declined")) {
        setDone(payload.outcome);
        // Re-render the server state too, so a refresh shows the same thing.
        router.refresh();
        return;
      }
      if (payload?.outcome === "already_responded") {
        router.refresh();
        return;
      }
      setError("That didn't go through. Give it another try, or just call.");
    } catch {
      setError("That didn't go through. Give it another try, or just call.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done === "accepted") {
    return (
      <div role="status">
        <p className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.012em] text-accent-text">
          <CheckMark />
          Approved. You&rsquo;re on the books.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{organizationName} will be in touch to schedule the work.</p>
      </div>
    );
  }
  if (done === "declined") {
    return (
      <div role="status">
        <p className="text-[17px] font-semibold tracking-[-0.012em] text-ink">Got it — you passed on this quote.</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">Nothing else happens from here.</p>
      </div>
    );
  }

  const primary =
    "inline-flex min-h-[52px] w-full items-center justify-center rounded-[7px] bg-accent px-6 text-[15.5px] font-semibold text-white shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_1px_2px_rgba(13,21,18,0.12)] transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";
  const quiet =
    "inline-flex min-h-[44px] w-full items-center justify-center rounded-[7px] px-4 text-[15px] font-medium text-ink-3 transition-colors hover:bg-inset hover:text-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-2";

  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_264px] sm:items-center sm:gap-12">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.012em] text-ink">
          {arming === "accept" ? "Confirm your approval" : arming === "decline" ? "Pass on this quote?" : "Your approval"}
        </h2>
        <p className="mt-1.5 max-w-[420px] text-[15px] leading-relaxed text-ink-2">
          {arming === "decline"
            ? "Nothing else happens from here."
            : `Approving tells ${organizationName} to go ahead. They will be in touch to schedule the work.`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {arming === "accept" ? (
          <button type="button" disabled={submitting} onClick={() => submit("accept")} className={primary}>
            {submitting ? "Approving…" : `Yes, approve${amountLabel ? ` — ${amountLabel}` : ""}`}
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setArming("accept");
              setError(null);
            }}
            className={primary}
          >
            Approve this quote
          </button>
        )}

        {arming === "decline" ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit("decline")}
            className="inline-flex min-h-[48px] w-full items-center justify-center rounded-[7px] border border-line-strong bg-surface px-4 text-[15px] font-semibold text-ink-2 transition-colors hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "One sec…" : "Yes — no thanks"}
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setArming("decline");
              setError(null);
            }}
            className={quiet}
          >
            No thanks
          </button>
        )}

        {arming ? (
          <button
            type="button"
            onClick={() => setArming(null)}
            className="min-h-[40px] rounded text-center text-sm font-medium text-ink-3 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15"
          >
            Go back
          </button>
        ) : null}

        {error ? (
          <p role="alert" className="text-center text-sm font-medium text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
