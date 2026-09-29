"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Receipt } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { buildCreateInvoiceInput, defaultCreateInvoiceForm, type CreateInvoiceJobContext } from "@/lib/invoices/forms";
import { formatMoney } from "@/lib/invoices/domain";
import { createInvoiceFromJob } from "../../../invoices/actions";

/**
 * Phase 1B-3: "Create invoice" from a job. Produces a DRAFT only - issuing
 * is a separate, explicit step on the invoice page. Prefills the contracted
 * amount when the job has one; when it doesn't, the total is required and
 * the "also set as contracted amount" checkbox defaults on (and is one tap
 * to turn off). Client validation mirrors the server's wording; the server
 * action and the database remain authoritative.
 */
export function CreateInvoiceButton({ job }: { job: CreateInvoiceJobContext }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={secondaryButtonAutoClass}>
        <Receipt aria-hidden className="h-4 w-4" />
        Create invoice
      </button>
      {open ? <CreateInvoiceDialog job={job} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function CreateInvoiceDialog({ job, onClose }: { job: CreateInvoiceJobContext; onClose: () => void }) {
  const router = useRouter();
  const [values, setValues] = useState(() => defaultCreateInvoiceForm(job));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const jobHasAmount = job.amount != null;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    setError(null);
    const built = buildCreateInvoiceInput(values, job);
    if (built.error !== undefined) {
      setError(built.error);
      return;
    }
    startTransition(async () => {
      const result = await createInvoiceFromJob(built.input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/invoices/${result.data.id}`);
    });
  }

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="create-invoice-title">
      <DialogTitle id="create-invoice-title">Create invoice</DialogTitle>
      <DialogDescription>
        Creates a draft for <span className="font-medium text-ink-2">{job.title}</span>. You can review it before issuing; nothing is sent to the customer.
      </DialogDescription>

      <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
        {error ? (
          <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="create-invoice-title-input" className={labelClass}>
            Title
          </label>
          <input id="create-invoice-title-input" value={values.title} onChange={(e) => setValues({ ...values, title: e.target.value })} className={inputClass} placeholder={job.title} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="create-invoice-amount" className={labelClass}>
            Invoice total
          </label>
          <input
            id="create-invoice-amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={values.amountRaw}
            onChange={(e) => setValues({ ...values, amountRaw: e.target.value })}
            className={inputClass}
            placeholder="0.00"
            required
          />
          <p className="text-xs text-ink-3">
            {jobHasAmount
              ? `Prefilled from the job's contracted amount (${formatMoney(job.amount as number)}). Changing it here does not change the job.`
              : "This job has no contracted amount yet, so the total is required."}
          </p>
        </div>

        {!jobHasAmount ? (
          <label className="flex items-start gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={values.alsoSetJobAmount}
              onChange={(e) => setValues({ ...values, alsoSetJobAmount: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-line-strong text-accent focus:ring-accent/30"
            />
            <span>
              Also set this as the job&rsquo;s contracted amount
              <span className="block text-xs text-ink-3">Fills in the job&rsquo;s empty amount so Money and Insights stop showing it as unknown.</span>
            </span>
          </label>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="create-invoice-due" className={labelClass}>
            Due date <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <input id="create-invoice-due" type="date" value={values.dueDate} onChange={(e) => setValues({ ...values, dueDate: e.target.value })} className={inputClass} />
          <p className="text-xs text-ink-3">Leave blank to use 14 days from the day you issue it.</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="create-invoice-notes" className={labelClass}>
            Internal notes <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <textarea id="create-invoice-notes" rows={3} value={values.notes} onChange={(e) => setValues({ ...values, notes: e.target.value })} className={inputClass} placeholder="Only your team sees these" />
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass} disabled={isPending}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Creating…" : "Create draft"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
