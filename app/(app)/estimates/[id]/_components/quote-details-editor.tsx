"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonSmallClass, secondaryButtonSmallClass } from "@/lib/ui/form";
import { detailLabelClass } from "@/lib/ui/typography";
import {
  formatLineMoney,
  formatQuantity,
  lineItemTotal,
  lineItemsMatchTotal,
  lineItemsSubtotal,
  LINE_ITEM_DESCRIPTION_MAX,
  LINE_ITEM_UNIT_MAX,
  QUOTE_TEXT_MAX,
  type EstimateDetails,
  type EstimateLineItem,
} from "@/lib/estimates/details";
import { addEstimateLineItem, removeEstimateLineItem, saveEstimateQuoteText, updateEstimateLineItem, type QuoteDetailsResult } from "../../quote-details-actions";

type Fields = { description: string; quantity: string; unit: string; unitPrice: string };
const EMPTY: Fields = { description: "", quantity: "1", unit: "", unitPrice: "" };
const toFields = (item: EstimateLineItem): Fields => ({ description: item.description, quantity: String(item.quantity), unit: item.unit ?? "", unitPrice: item.unitPrice.toFixed(2) });

/**
 * What the customer reads on the quote: the itemized work and the scope and
 * terms. Editable only while the estimate is a draft (the server actions and
 * the database enforce the same); a sent quote shows exactly what the
 * customer saw. Every button calls one server action in
 * ../../quote-details-actions - the totals shown here are previews, the
 * server recomputes the estimate's amount from the saved items.
 */
export function QuoteDetailsEditor({ estimateId, editable, details, amount }: { estimateId: string; editable: boolean; details: EstimateDetails; amount: number | null }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [scope, setScope] = useState(details.scopeOfWork ?? "");
  const [terms, setTerms] = useState(details.terms ?? "");
  const [textSaved, setTextSaved] = useState(false);

  const items = details.lineItems;
  const subtotal = lineItemsSubtotal(items);
  const textDirty = scope !== (details.scopeOfWork ?? "") || terms !== (details.terms ?? "");

  function run(action: () => Promise<QuoteDetailsResult>, after?: () => void) {
    setError(null);
    setTextSaved(false);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function startEdit(target: EstimateLineItem | "new") {
    setError(null);
    setEditingId(target === "new" ? "new" : target.id);
    setFields(target === "new" ? EMPTY : toFields(target));
  }

  function saveItem() {
    if (editingId === "new") run(() => addEstimateLineItem(estimateId, fields), () => { setEditingId(null); setFields(EMPTY); });
    else if (editingId) run(() => updateEstimateLineItem(estimateId, editingId, fields), () => setEditingId(null));
  }

  const itemForm = (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-inset/50 p-3 sm:grid-cols-[minmax(0,1fr)_80px_80px_110px]">
      <div className="col-span-2 space-y-1 sm:col-span-1">
        <label htmlFor="line-description" className={labelClass}>Description</label>
        <input id="line-description" value={fields.description} maxLength={LINE_ITEM_DESCRIPTION_MAX} onChange={(e) => setFields({ ...fields, description: e.target.value })} className={inputClass} placeholder="e.g. Tear off existing shingles" />
      </div>
      <div className="space-y-1">
        <label htmlFor="line-quantity" className={labelClass}>Qty</label>
        <input id="line-quantity" value={fields.quantity} inputMode="decimal" onChange={(e) => setFields({ ...fields, quantity: e.target.value })} className={inputClass} />
      </div>
      <div className="space-y-1">
        <label htmlFor="line-unit" className={labelClass}>Unit</label>
        <input id="line-unit" value={fields.unit} maxLength={LINE_ITEM_UNIT_MAX} onChange={(e) => setFields({ ...fields, unit: e.target.value })} className={inputClass} placeholder="sq, hr" />
      </div>
      <div className="col-span-2 space-y-1 sm:col-span-1">
        <label htmlFor="line-price" className={labelClass}>Unit price</label>
        <input id="line-price" value={fields.unitPrice} inputMode="decimal" onChange={(e) => setFields({ ...fields, unitPrice: e.target.value })} className={inputClass} placeholder="0.00" />
      </div>
      <div className="col-span-2 flex justify-end gap-2 sm:col-span-4">
        <button type="button" onClick={() => setEditingId(null)} className={ghostButtonClass} disabled={isPending}>Cancel</button>
        <button type="button" onClick={saveItem} className={primaryButtonSmallClass} disabled={isPending}>
          {isPending ? "Saving…" : editingId === "new" ? "Add item" : "Save item"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {error ? <p className={errorBannerClass} role="alert">{error}</p> : null}

      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className={detailLabelClass}>Line items</h3>
          {editable && details.lineItemsAvailable && editingId === null ? (
            <button type="button" onClick={() => startEdit("new")} className={secondaryButtonSmallClass}>Add line item</button>
          ) : null}
        </div>

        {!details.lineItemsAvailable ? (
          <p className="mt-2 text-sm text-ink-3">Itemized quotes aren&rsquo;t enabled on this workspace&rsquo;s database yet. The quote shows its single total.</p>
        ) : items.length === 0 && editingId !== "new" ? (
          <p className="mt-2 text-sm text-ink-3">
            {editable ? "No line items. The quote shows its single total - add items to give the customer a breakdown." : "This quote was sent with a single total."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-medium text-ink-3">
                  <th className="py-2 pr-3 font-medium">Description</th>
                  <th className="py-2 pr-3 text-right font-medium">Qty</th>
                  <th className="py-2 pr-3 text-right font-medium">Unit price</th>
                  <th className="py-2 text-right font-medium">Total</th>
                  {editable ? <th className="w-[72px] py-2"><span className="sr-only">Actions</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((item) =>
                  editingId === item.id ? (
                    <tr key={item.id}><td colSpan={editable ? 5 : 4} className="py-2">{itemForm}</td></tr>
                  ) : (
                    <tr key={item.id} className="border-b border-line/70 align-top">
                      <td className="py-2.5 pr-3 text-ink">{item.description}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-2">{formatQuantity(item.quantity)}{item.unit ? ` ${item.unit}` : ""}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-2">{formatLineMoney(item.unitPrice)}</td>
                      <td className="py-2.5 text-right tabular-nums text-ink">{formatLineMoney(lineItemTotal(item))}</td>
                      {editable ? (
                        <td className="py-1.5 text-right">
                          <button type="button" aria-label={`Edit ${item.description}`} onClick={() => startEdit(item)} disabled={isPending || editingId !== null} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-inset hover:text-ink disabled:opacity-40">
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button type="button" aria-label={`Remove ${item.description}`} onClick={() => run(() => removeEstimateLineItem(estimateId, item.id))} disabled={isPending || editingId !== null} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-danger-muted hover:text-danger-text disabled:opacity-40">
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ),
                )}
              </tbody>
              {items.length > 0 ? (
                <tfoot>
                  <tr>
                    <td colSpan={3} className="pt-3 pr-3 text-right text-xs font-medium uppercase tracking-wide text-ink-3">Subtotal</td>
                    <td className="pt-3 text-right font-semibold tabular-nums text-ink">{formatLineMoney(subtotal)}</td>
                    {editable ? <td /> : null}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}
        {editingId === "new" ? <div className="mt-3">{itemForm}</div> : null}
        {items.length > 0 && !lineItemsMatchTotal(items, amount) ? (
          <p className="mt-3 text-sm text-warning-text" role="status">
            The line items don&rsquo;t add up to this estimate&rsquo;s amount, so the customer sees only the total. {editable ? "Saving any line item or sending the quote sets the amount to the subtotal." : ""}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(["scope", "terms"] as const).map((key) => {
          const label = key === "scope" ? "Scope of work" : "Terms";
          const value = key === "scope" ? scope : terms;
          const id = `quote-${key}`;
          if (!details.textFieldsAvailable) return null;
          if (!editable) {
            return (
              <div key={key}>
                <h3 className={detailLabelClass}>{label}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{value || "—"}</p>
              </div>
            );
          }
          return (
            <div key={key} className="space-y-1.5">
              <label htmlFor={id} className={labelClass}>{label}</label>
              <textarea
                id={id}
                rows={5}
                maxLength={QUOTE_TEXT_MAX}
                value={value}
                onChange={(e) => (key === "scope" ? setScope(e.target.value) : setTerms(e.target.value))}
                className={inputClass}
                placeholder={key === "scope" ? "What the work includes, as the customer should read it" : "Deposit, payment schedule, warranty - exactly as you offer them"}
              />
            </div>
          );
        })}
      </div>
      {editable && details.textFieldsAvailable ? (
        <div className="flex items-center justify-end gap-3">
          {textSaved ? <span className="text-sm text-accent-text" role="status">Saved</span> : null}
          <button
            type="button"
            disabled={isPending || !textDirty}
            onClick={() => run(() => saveEstimateQuoteText(estimateId, { scopeOfWork: scope, terms }), () => setTextSaved(true))}
            className={secondaryButtonSmallClass}
          >
            {isPending ? "Saving…" : "Save scope & terms"}
          </button>
        </div>
      ) : null}
      {editable ? <p className="text-xs text-ink-3">The customer sees line items, scope and terms on the quote link. Internal notes stay private.</p> : null}
    </div>
  );
}
