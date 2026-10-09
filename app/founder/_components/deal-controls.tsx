"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { DEAL_STAGES, DEAL_STAGE_LABELS, type FounderDeal } from "@/lib/founder/model";
import { deleteFounderDeal, moveFounderDealStage } from "../actions";
import { DealDialog } from "./deal-dialog";

export function AddDealButton({ timeZone, todayKey }: { timeZone: string; todayKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        New deal
      </button>
      {open ? <DealDialog timeZone={timeZone} todayKey={todayKey} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Per-deal controls: move stage (won opens the edit form, since it needs an
 * amount and date), edit, delete (two-step).
 */
export function DealControls({ deal, timeZone, todayKey }: { deal: FounderDeal; timeZone: string; todayKey: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
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

  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={`stage-${deal.id}`} className="sr-only">Stage for {deal.name}</label>
      <select
        id={`stage-${deal.id}`}
        value={deal.stage}
        disabled={isPending}
        onChange={(e) => {
          if (e.target.value === "won") setEditing(true);
          else run(() => moveFounderDealStage(deal.id, e.target.value));
        }}
        className="h-9 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {DEAL_STAGES.map((stage) => (
          <option key={stage} value={stage}>{DEAL_STAGE_LABELS[stage]}</option>
        ))}
      </select>
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
          <button type="button" aria-label={`Edit ${deal.name}`} onClick={() => setEditing(true)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" aria-label={`Delete ${deal.name}`} onClick={() => setConfirming(true)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-danger-muted hover:text-danger-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </>
      )}
      {error ? (
        <p role="alert" className="w-full text-xs font-medium text-danger-text">
          {error}
        </p>
      ) : null}
      {editing ? <DealDialog deal={deal} timeZone={timeZone} todayKey={todayKey} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
