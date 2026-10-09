"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Estimate } from "@/lib/estimates/queries";
import { ContactPicker } from "../../_components/contact-picker";
import { LeadPicker } from "../../appointments/_components/lead-picker";
import { QUOTE_TEXT_MAX, type QuoteTextFields } from "@/lib/estimates/details";
import { createEstimate, updateEstimate, type EstimateFormState } from "../actions";

const initialState: EstimateFormState = {};

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

export function EstimateDialog({
  mode,
  contacts,
  leads,
  estimate,
  defaultContactId,
  defaultLeadId,
  amountFromLineItems = false,
  quoteText,
  onClose,
}: {
  mode: "create" | "edit";
  contacts: Contact[];
  leads: Lead[];
  estimate?: Estimate;
  /** Pre-selects the contact picker in create mode - see AddEstimateButton's own comment for why. Ignored in edit mode (the estimate's own contact always wins). */
  defaultContactId?: string;
  /** Create mode: pre-selects this lead (the lead page's "New estimate"). */
  defaultLeadId?: string;
  /** Edit mode: the saved customer-facing scope and terms. Omitted = the fields aren't available on this database, so they're not shown. */
  quoteText?: QuoteTextFields | null;
  /** Edit mode of an itemized estimate: the amount is the line-item subtotal (updateEstimate enforces it), so it is shown read-only. */
  amountFromLineItems?: boolean;
  onClose: () => void;
}) {
  const action = mode === "create" ? createEstimate : updateEstimate;
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [contactId, setContactId] = useState(estimate?.contact_id ?? defaultContactId ?? "");
  const defaultContact = estimate?.contact ?? (defaultContactId ? (contacts.find((contact) => contact.id === defaultContactId) ?? null) : null);
  const closedRef = useRef(false);
  const router = useRouter();
  // Create shows the fields (an unavailable column is reported after saving);
  // edit shows them only when the estimate page could read them.
  const showQuoteText = mode === "create" || quoteText != null;

  useEffect(() => {
    if (!state.success || closedRef.current || state.warning) return;
    closedRef.current = true;
    if (mode === "create" && state.id) {
      // A new estimate opens as a draft on its own page - where line items,
      // scope and terms are edited and the quote is sent.
      router.push(`/estimates/${state.id}`);
      return;
    }
    onClose();
  }, [state.success, state.warning, state.id, mode, router, onClose]);

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="estimate-dialog-title">
      <DialogTitle id="estimate-dialog-title">{mode === "create" ? "New Estimate" : "Edit Estimate"}</DialogTitle>

      <form action={formAction} className="mt-4 space-y-4">
          {mode === "edit" && estimate ? <input type="hidden" name="id" value={estimate.id} /> : null}

          {state.error ? <p className={errorBannerClass} role="alert">{state.error}</p> : null}
          {state.success && state.warning ? (
            <p className={errorBannerClass} role="alert">
              {state.warning}{" "}
              {state.id ? (
                <Link href={`/estimates/${state.id}`} className="font-medium underline">
                  Open estimate
                </Link>
              ) : null}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label className={labelClass}>Contact</label>
            <ContactPicker
              contacts={contacts}
              defaultContact={defaultContact}
              name="contactId"
              onSelect={(contact) => setContactId(contact?.id ?? "")}
            />
          </div>

          <div className="space-y-1.5">
            <label className={labelClass}>Lead</label>
            <LeadPicker leads={leads} contactId={contactId} defaultLeadId={estimate ? estimate.lead_id : defaultLeadId} defaultToNewestOpenLead={!estimate && !defaultLeadId} emptyLabel="No lead" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input
              id="title"
              name="title"
              defaultValue={estimate?.title ?? ""}
              className={inputClass}
              placeholder="e.g. AC Replacement"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="amount" className={labelClass}>
                Amount
              </label>
              <input
                id="amount"
                name="amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                defaultValue={estimate?.amount ?? ""}
                readOnly={amountFromLineItems}
                aria-describedby={amountFromLineItems ? "amount-from-items" : undefined}
                className={inputClass}
                placeholder="0.00"
              />
              {amountFromLineItems ? (
                <p id="amount-from-items" className="text-xs text-ink-3">
                  Set by the line items.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="expiresAt" className={labelClass}>
                Expires
              </label>
              <input
                id="expiresAt"
                name="expiresAt"
                type="date"
                defaultValue={estimate?.expires_at ? toDateInputValue(estimate.expires_at) : ""}
                className={inputClass}
              />
            </div>
          </div>

          {showQuoteText ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="scopeOfWork" className={labelClass}>
                  Scope of work
                </label>
                <textarea
                  id="scopeOfWork"
                  name="scopeOfWork"
                  rows={3}
                  maxLength={QUOTE_TEXT_MAX}
                  defaultValue={quoteText?.scopeOfWork ?? ""}
                  className={inputClass}
                  placeholder="What the work includes, as the customer should read it"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="terms" className={labelClass}>
                  Terms
                </label>
                <textarea
                  id="terms"
                  name="terms"
                  rows={3}
                  maxLength={QUOTE_TEXT_MAX}
                  defaultValue={quoteText?.terms ?? ""}
                  className={inputClass}
                  placeholder="Deposit, payment schedule, warranty - exactly as you offer them"
                />
                <p className="text-xs text-ink-3">Scope of work and terms are shown to the customer on the quote. Notes below stay internal.</p>
              </div>
            </>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={estimate?.notes ?? ""}
              className={inputClass}
              placeholder="Internal notes about this estimate"
            />
          </div>

          <DialogFooter>
            <button type="button" onClick={onClose} className={ghostButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create Estimate"
                  : "Save Changes"}
            </button>
          </DialogFooter>
        </form>
    </Dialog>
  );
}
