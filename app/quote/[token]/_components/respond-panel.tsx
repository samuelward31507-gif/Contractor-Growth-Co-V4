"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      <div className="rounded-xl bg-accent-muted px-5 py-4 text-center">
        <p className="text-[15px] font-semibold text-accent-text">Approved. You&rsquo;re on the books.</p>
        <p className="mt-1 text-sm text-accent-text/80">{organizationName} will be in touch to schedule the work.</p>
      </div>
    );
  }
  if (done === "declined") {
    return (
      <div className="rounded-xl bg-inset px-5 py-4 text-center">
        <p className="text-[15px] font-semibold text-ink-2">Got it — you passed on this quote.</p>
        <p className="mt-1 text-sm text-ink-3">Nothing else happens from here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {arming === "accept" ? (
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit("accept")}
          className="inline-flex min-h-[56px] w-full items-center justify-center rounded-xl bg-accent px-4 text-base font-semibold text-white transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
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
          className="inline-flex min-h-[56px] w-full items-center justify-center rounded-xl bg-accent px-4 text-base font-semibold text-white transition-colors hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2"
        >
          Approve this quote
        </button>
      )}

      {arming === "decline" ? (
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit("decline")}
          className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl border border-line bg-white px-4 text-[15px] font-semibold text-ink-2 transition-colors hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
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
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl px-4 text-[15px] font-medium text-ink-3 transition-colors hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-2"
        >
          No thanks
        </button>
      )}

      {arming ? (
        <button
          type="button"
          onClick={() => setArming(null)}
          className="text-center text-sm font-medium text-ink-3 underline-offset-2 hover:underline"
        >
          Go back
        </button>
      ) : null}

      {error ? <p className="text-center text-sm font-medium text-danger-text">{error}</p> : null}
    </div>
  );
}
