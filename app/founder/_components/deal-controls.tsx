"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { NotebookPen, Pencil, Plus, Trash2 } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { DEAL_STAGES, DEAL_STAGE_LABELS, isOpenDeal, type DealStage, type FounderDeal } from "@/lib/founder/model";
import { changeFounderDealStage, deleteFounderDeal } from "../actions";
import { DealDialog } from "./deal-dialog";
import { LogActivityDialog, StageChangeDialog } from "./sales-dialogs";

export function AddDealButton({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        New deal
      </button>
      {open ? <DealDialog timeZone={timeZone} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const ICON_BUTTON = "flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * Per-deal controls. Moving between open stages is one step (recorded in the
 * deal's history); won, lost and reopening open a dialog for the terms,
 * reason or note. Log records something that happened; edit changes the
 * details; delete only works for a deal with no recorded history.
 */
export function DealControls({ deal, timeZone, todayKey, nowIso }: { deal: FounderDeal; timeZone: string; todayKey: string; nowIso: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [changingTo, setChangingTo] = useState<DealStage | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      setConfirming(false);
      router.refresh();
    });
  }

  function chooseStage(next: DealStage) {
    if (next === deal.stage) return;
    if (next === "won" || next === "lost" || !isOpenDeal(deal)) setChangingTo(next);
    else run(() => changeFounderDealStage(deal.id, { toStage: next, requestId: crypto.randomUUID(), expectedUpdatedAt: deal.updatedAt }));
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={`stage-${deal.id}`} className="sr-only">Stage for {deal.name}</label>
      <select
        id={`stage-${deal.id}`}
        value={deal.stage}
        disabled={isPending}
        onChange={(e) => chooseStage(e.target.value as DealStage)}
        className="h-9 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {DEAL_STAGES.filter((s) => isOpenDeal(deal) || s === deal.stage || isOpenDeal({ stage: s })).map((s) => (
          <option key={s} value={s}>{!isOpenDeal(deal) && s !== deal.stage ? `Reopen at ${DEAL_STAGE_LABELS[s]}` : DEAL_STAGE_LABELS[s]}</option>
        ))}
      </select>
      <button type="button" aria-label={`Log activity for ${deal.name}`} title="Log activity" onClick={() => setLogging(true)} className={ICON_BUTTON}>
        <NotebookPen className="h-4 w-4" aria-hidden />
      </button>
      {confirming ? (
        <>
          <button type="button" disabled={isPending} onClick={() => run(() => deleteFounderDeal(deal.id))} className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted">
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
            Keep
          </button>
        </>
      ) : (
        <>
          <button type="button" aria-label={`Edit ${deal.name}`} onClick={() => setEditing(true)} className={ICON_BUTTON}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" aria-label={`Delete ${deal.name}`} onClick={() => setConfirming(true)} className={`${ICON_BUTTON} hover:bg-danger-muted hover:text-danger-text`}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </>
      )}
      {error ? (
        <p role="alert" className="w-full text-xs font-medium text-danger-text">
          {error}
        </p>
      ) : null}
      {editing ? <DealDialog deal={deal} timeZone={timeZone} onClose={() => setEditing(false)} /> : null}
      {logging ? <LogActivityDialog deal={deal} timeZone={timeZone} nowIso={nowIso} onClose={() => setLogging(false)} /> : null}
      {changingTo ? <StageChangeDialog deal={deal} toStage={changingTo} todayKey={todayKey} onClose={() => setChangingTo(null)} /> : null}
    </div>
  );
}
