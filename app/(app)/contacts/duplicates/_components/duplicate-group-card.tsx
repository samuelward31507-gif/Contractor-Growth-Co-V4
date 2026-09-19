"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { errorBannerClass, primaryButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { DuplicateMatchReason, ContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { mergeContacts } from "../actions";

const secondaryBtn =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

const REASON_LABEL: Record<DuplicateMatchReason, string> = {
  phone: "Same phone number",
  email: "Same email address",
  phone_and_email: "Same phone number and email address",
};

function contactLabel(contact: Contact): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.company_name || "(no name)";
}

function relationshipSummary(counts: ContactRelationshipCounts | undefined): string {
  if (!counts) return "";
  const parts = [
    counts.leads ? `${counts.leads} lead${counts.leads === 1 ? "" : "s"}` : null,
    counts.conversations ? `${counts.conversations} conversation${counts.conversations === 1 ? "" : "s"}` : null,
    counts.appointments ? `${counts.appointments} appointment${counts.appointments === 1 ? "" : "s"}` : null,
    counts.estimates ? `${counts.estimates} estimate${counts.estimates === 1 ? "" : "s"}` : null,
    counts.jobs ? `${counts.jobs} job${counts.jobs === 1 ? "" : "s"}` : null,
    counts.reviewRequests ? `${counts.reviewRequests} review request${counts.reviewRequests === 1 ? "" : "s"}` : null,
    counts.referralRequests ? `${counts.referralRequests} referral request${counts.referralRequests === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No related records";
}

/**
 * One potential-duplicate group (2+ contacts sharing an exact normalized
 * phone or email - never a fuzzy/name match, see lib/contacts/duplicates.ts).
 * The admin picks one contact as the survivor (radio), then merges any
 * other contact in the group into it one at a time - each merge is its own
 * explicit, confirmed action, never a bulk one-click operation.
 */
export function DuplicateGroupCard({
  reason,
  contacts,
  relationshipCounts,
  canMerge,
}: {
  reason: DuplicateMatchReason;
  contacts: Contact[];
  relationshipCounts: Record<string, ContactRelationshipCounts>;
  canMerge: boolean;
}) {
  const [targetId, setTargetId] = useState(contacts[0]?.id ?? "");
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const [confirmingSourceId, setConfirmingSourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function runMerge(sourceId: string) {
    setError(null);
    setSuccess(null);
    setPendingSourceId(sourceId);
    startTransition(async () => {
      const result = await mergeContacts(sourceId, targetId, `Merged via duplicate review (${reason})`);
      setPendingSourceId(null);
      setConfirmingSourceId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess("Merged successfully.");
      router.refresh();
    });
  }

  const target = contacts.find((c) => c.id === targetId);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{REASON_LABEL[reason]}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {contacts.length} contacts share this identity. Pick the contact to keep, then merge the others into it - every lead,
            conversation, appointment, estimate, job, and review/referral request moves to the surviving contact. The survivor keeps
            its own details; anything it&apos;s missing is filled in from the merged contact.
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {contacts.map((contact) => {
          const isTarget = contact.id === targetId;
          return (
            <div key={contact.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                {canMerge ? (
                  <input
                    type="radio"
                    name={`target-${contacts.map((c) => c.id).join("-")}`}
                    checked={isTarget}
                    onChange={() => setTargetId(contact.id)}
                    aria-label={`Keep ${contactLabel(contact)} as the surviving contact`}
                  />
                ) : null}
                <div>
                  <p className="text-sm font-medium text-slate-900">{contactLabel(contact)}</p>
                  <p className="text-xs text-slate-500">
                    {[contact.phone, contact.email, contact.company_name].filter(Boolean).join(" · ") || "No additional details"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{relationshipSummary(relationshipCounts[contact.id])}</p>
                </div>
              </div>

              {canMerge && !isTarget ? (
                confirmingSourceId === contact.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Merge into {target ? contactLabel(target) : "the selected contact"}?</span>
                    <button type="button" disabled={isPending} onClick={() => runMerge(contact.id)} className={primaryButtonAutoClass}>
                      {isPending && pendingSourceId === contact.id ? "Merging…" : "Confirm merge"}
                    </button>
                    <button type="button" disabled={isPending} onClick={() => setConfirmingSourceId(null)} className={secondaryBtn}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" disabled={isPending} onClick={() => setConfirmingSourceId(contact.id)} className={secondaryBtn}>
                    Merge into survivor
                  </button>
                )
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? <p className={`m-5 ${errorBannerClass}`}>{error}</p> : null}
      {success ? <p className="mx-5 mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">{success}</p> : null}
    </div>
  );
}

