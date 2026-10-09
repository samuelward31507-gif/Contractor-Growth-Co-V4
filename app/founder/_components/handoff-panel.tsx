"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import type { FounderDeal } from "@/lib/founder/model";
import { SCOPE_MAX, SCOPE_MIN, handoffOutOfDate, type HandoffState } from "@/lib/founder/handoff";
import { formatDateTime, formatMoney } from "@/lib/founder/format";
import { cancelFounderClientHandoff, prepareClientHandoff } from "../actions";

/** The one-line status shown on a won deal's card. */
export function HandoffBadge({ state }: { state: HandoffState }) {
  switch (state.kind) {
    case "missing_info":
      return <Badge tone="warning">Handoff: info missing</Badge>;
    case "ready":
      return <Badge tone="info">Ready to hand off</Badge>;
    case "prepared":
      return <Badge tone="info">Handoff awaiting Agency</Badge>;
    case "confirmed":
      return <Badge tone="success">Agency client created</Badge>;
    default:
      return null;
  }
}

/**
 * Client handoff on a won deal. Preparing copies only the agreed fields and
 * the scope written here - it creates no client and changes nothing on the
 * deal. An agency admin confirms separately, on the Agency side; until then
 * the founder can cancel (with a reason) and prepare again.
 */
export function HandoffPanel({ deal, state, timeZone }: { deal: FounderDeal; state: HandoffState; timeZone: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (state.kind === "not_won") return null;

  function cancel(handoffId: string) {
    setError(null);
    startTransition(async () => {
      const result = await cancelFounderClientHandoff(handoffId, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCancelling(false);
      setReason("");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="handoff-title" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="handoff-title" className="text-sm font-semibold text-ink">Client handoff</h2>
        <HandoffBadge state={state} />
      </div>

      {state.kind === "missing_info" ? (
        <div className="mt-2 text-sm text-ink-2">
          <p>Before this deal can be handed to Agency delivery, add:</p>
          <ul className="mt-1 list-disc pl-5" aria-label="Missing for handoff">
            {state.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-3">Edit the deal to add contact details. The scope is written when you prepare the handoff.</p>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-2">Won and complete. Preparing a handoff sends the agreed terms and scope to the Agency for confirmation - it doesn&rsquo;t create a client by itself.</p>
          <button type="button" onClick={() => setPreparing(true)} className={primaryButtonAutoClass}>
            Prepare client handoff
          </button>
        </div>
      ) : null}

      {state.kind === "prepared" ? (
        <div className="mt-2 space-y-2 text-sm text-ink-2">
          <p>
            Prepared {formatDateTime(state.handoff.preparedAt, timeZone)} - waiting for an agency admin to confirm. No Agency client exists yet.
          </p>
          {handoffOutOfDate(state.handoff, deal) ? (
            <p role="status" className="text-xs font-medium text-warning-text">
              The deal changed after this was prepared, so it can&rsquo;t be confirmed as is. Cancel it and prepare a new one.
            </p>
          ) : null}
          {cancelling ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="handoff-cancel-reason" className="sr-only">Why cancel the handoff</label>
              <input id="handoff-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why cancel?" className={`${inputClass} h-9 flex-1 text-sm`} />
              <button type="button" disabled={isPending || !reason.trim()} onClick={() => cancel(state.handoff.id)} className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted disabled:opacity-50">
                Cancel handoff
              </button>
              <button type="button" onClick={() => setCancelling(false)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
                Keep
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setCancelling(true)} className={secondaryButtonAutoClass}>
              Cancel handoff
            </button>
          )}
        </div>
      ) : null}

      {state.kind === "confirmed" ? (
        <div className="mt-2 space-y-1 text-sm text-ink-2">
          <p>Confirmed {state.handoff.confirmedAt ? formatDateTime(state.handoff.confirmedAt, timeZone) : ""} - the Agency client exists and delivery is tracked in the Agency Command Center.</p>
          {state.dealReopened ? <p role="status" className="text-xs font-medium text-warning-text">This deal was reopened after the handoff. The Agency client was not changed - tell the Agency if the engagement is off.</p> : null}
        </div>
      ) : null}

      {state.cancelled.length ? (
        <details className="mt-3 text-xs text-ink-3">
          <summary className="cursor-pointer">Cancelled handoffs ({state.cancelled.length})</summary>
          <ul className="mt-1 space-y-1">
            {state.cancelled.map((h) => (
              <li key={h.id}>
                {h.cancelledAt ? formatDateTime(h.cancelledAt, timeZone) : ""}: {h.cancelReason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? <p role="alert" className="mt-2 text-xs font-medium text-danger-text">{error}</p> : null}
      {preparing ? <PrepareHandoffDialog deal={deal} onClose={() => setPreparing(false)} /> : null}
    </section>
  );
}

function PrepareHandoffDialog({ deal, onClose }: { deal: FounderDeal; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // One request id per open dialog: a double click or retry prepares once.
  const [requestId] = useState(() => crypto.randomUUID());

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await prepareClientHandoff(deal.id, { scope: formData.get("scope"), requestId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  const rows: [string, string][] = [
    ["Client", deal.name],
    ["Decision-maker", deal.contactName ?? "—"],
    ["Contact", [deal.contactEmail, deal.contactPhone].filter(Boolean).join(" · ") || "—"],
    ["Setup fee (agreed)", deal.wonSetupFee != null ? formatMoney(deal.wonSetupFee, deal.currency) : "—"],
    ["Monthly fee (agreed)", deal.wonMonthlyFee != null ? `${formatMoney(deal.wonMonthlyFee, deal.currency)}/mo` : "—"],
  ];
  return (
    <Dialog onClose={onClose} labelledBy="prepare-handoff-title" className="max-h-[90vh] max-w-lg overflow-y-auto">
      <DialogTitle id="prepare-handoff-title">Prepare client handoff</DialogTitle>
      <form action={submit} className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-ink-3">Only these fields go to the Agency. Nothing else on the deal - notes, history, other contacts - is shared, and the deal itself isn&rsquo;t changed.</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-inset/60 p-3 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-3">{label}</dt>
              <dd className="break-words text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-1.5">
          <label htmlFor="handoff-scope" className={labelClass}>Agreed scope</label>
          <textarea id="handoff-scope" name="scope" required minLength={SCOPE_MIN} maxLength={SCOPE_MAX} rows={5} className={inputClass} placeholder="What was sold: services, deliverables, timeline, anything promised." />
        </div>
        <p className="text-xs text-ink-3">An agency admin reviews and confirms this separately. Until then no Agency client exists, and you can cancel.</p>
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>Cancel</button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Preparing…" : "Prepare handoff"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
