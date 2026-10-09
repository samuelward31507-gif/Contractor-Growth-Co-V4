"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { MRR_KINDS, MRR_KIND_LABELS } from "@/lib/founder/model";
import { createFounderMrrEntry, deleteFounderMrrEntry } from "../actions";

/** Add a manual MRR movement or one-time revenue, as an actual or a forecast. */
export function MrrEntryForm({ currentMonth }: { currentMonth: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setMessage(null);
    startTransition(async () => {
      const result = await createFounderMrrEntry(fields);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      formRef.current?.reset();
      setMessage({ tone: "ok", text: "Entry added." });
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={submit} className="space-y-3">
      {message?.tone === "error" ? (
        <p className={errorBannerClass} role="alert">
          {message.text}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="space-y-1.5">
          <label htmlFor="mrr-month" className={labelClass}>Month</label>
          <input id="mrr-month" name="month" type="month" required defaultValue={currentMonth.slice(0, 7)} className={inputClass} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="mrr-kind" className={labelClass}>Type</label>
          <select id="mrr-kind" name="kind" required defaultValue="new" className={inputClass}>
            {MRR_KINDS.map((kind) => (
              <option key={kind} value={kind}>{MRR_KIND_LABELS[kind]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="mrr-amount" className={labelClass}>Amount (monthly)</label>
          <input id="mrr-amount" name="amount" required inputMode="decimal" className={inputClass} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="mrr-customer" className={labelClass}>Customer (optional)</label>
          <input id="mrr-customer" name="customer" maxLength={200} className={inputClass} />
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="mrr-description" className={labelClass}>Note (optional)</label>
        <input id="mrr-description" name="description" maxLength={500} className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2 sm:min-h-0">
          <input type="checkbox" name="isForecast" className="h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]" />
          This is a forecast, not an actual
        </label>
        <div className="flex items-center gap-3">
          {message?.tone === "ok" ? (
            <span role="status" className="text-sm text-accent-text">
              {message.text}
            </span>
          ) : null}
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Add entry"}
          </button>
        </div>
      </div>
    </form>
  );
}

export function DeleteMrrEntryButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteFounderMrrEntry(id);
              if (!result.ok) setError(result.error);
              setConfirming(false);
              router.refresh();
            })
          }
          className="min-h-9 rounded-md px-2 text-xs font-semibold text-danger-text hover:bg-danger-muted"
        >
          Delete
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
          Keep
        </button>
      </span>
    );
  }
  return (
    <>
      <button type="button" aria-label={`Delete ${label}`} onClick={() => setConfirming(true)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-danger-muted hover:text-danger-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
      {error ? <span role="alert" className="text-xs text-danger-text">{error}</span> : null}
    </>
  );
}
