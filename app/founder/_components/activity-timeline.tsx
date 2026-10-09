"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inputClass } from "@/lib/ui/form";
import { DEAL_STAGE_LABELS } from "@/lib/founder/model";
import { ACTIVITY_CHANNEL_LABELS, ACTIVITY_KIND_LABELS, isStageKind, type DealActivity } from "@/lib/founder/sales";
import { formatDateTime, formatMoney } from "@/lib/founder/format";
import { voidFounderDealActivity } from "../actions";

/**
 * A deal's recorded history, newest first. Everything shown was logged by
 * hand or recorded with a stage change; a logged entry recorded in error can
 * be voided with a reason (it stays, struck through). Stage history can't be
 * voided - the next stage change is the correction.
 */
export function ActivityTimeline({ activities, timeZone }: { activities: DealActivity[]; timeZone: string }) {
  if (!activities.length) return <p className="text-sm text-ink-3">Nothing recorded on this deal yet. Log outreach, replies, meetings and proposals as they happen.</p>;
  return (
    <ol className="space-y-3" aria-label="Deal history">
      {activities.map((a) => (
        <TimelineEntry key={a.id} activity={a} timeZone={timeZone} />
      ))}
    </ol>
  );
}

function TimelineEntry({ activity: a, timeZone }: { activity: DealActivity; timeZone: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const voided = a.voidedAt != null;

  function confirmVoid() {
    setError(null);
    startTransition(async () => {
      const result = await voidFounderDealActivity(a.id, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setVoiding(false);
      router.refresh();
    });
  }

  const transition = a.fromStage && a.toStage ? `${DEAL_STAGE_LABELS[a.fromStage]} → ${DEAL_STAGE_LABELS[a.toStage]}` : null;
  return (
    <li className="border-l-2 border-line pl-3" data-kind={a.kind}>
      <div className={`flex flex-wrap items-baseline gap-x-2 text-sm ${voided ? "text-ink-4 line-through" : "text-ink"}`}>
        <span className="font-medium">{ACTIVITY_KIND_LABELS[a.kind]}</span>
        {transition ? <span className="text-ink-2">{transition}</span> : null}
        {a.channel ? <span className="text-xs text-ink-3">{ACTIVITY_CHANNEL_LABELS[a.channel]}</span> : null}
      </div>
      <p className="text-xs text-ink-3">
        {formatDateTime(a.occurredAt, timeZone)}
        {a.scheduledFor ? ` · meeting ${formatDateTime(a.scheduledFor, timeZone)}` : ""}
      </p>
      {a.kind === "won" && a.setupFee != null && a.monthlyFee != null && a.currency ? (
        <p className="text-xs text-ink-2">
          Agreed: {formatMoney(a.setupFee, a.currency)} setup + {formatMoney(a.monthlyFee, a.currency)}/mo (contracted, not collected)
        </p>
      ) : null}
      {a.summary ? <p className={`mt-0.5 text-sm ${voided ? "text-ink-4 line-through" : "text-ink-2"}`}>{a.summary}</p> : null}
      {voided ? <p className="mt-0.5 text-xs text-ink-3">Voided: {a.voidReason}</p> : null}
      {!voided && !isStageKind(a.kind) ? (
        voiding ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <label htmlFor={`void-${a.id}`} className="sr-only">Why this entry is wrong</label>
            <input id={`void-${a.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why is this entry wrong?" className={`${inputClass} h-9 flex-1 text-xs`} />
            <button type="button" disabled={isPending || !reason.trim()} onClick={confirmVoid} className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted disabled:opacity-50">
              Void
            </button>
            <button type="button" onClick={() => setVoiding(false)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
              Keep
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setVoiding(true)} className="mt-0.5 text-xs font-medium text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline">
            Recorded in error?
          </button>
        )
      ) : null}
      {error ? <p role="alert" className="mt-1 text-xs font-medium text-danger-text">{error}</p> : null}
    </li>
  );
}
