"use client";

import { useActionState } from "react";
import { primaryButtonAutoClass, errorBannerClass, successBannerClass, ghostButtonClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { contactDisplayName } from "@/lib/contacts/format";
import type { Lead } from "@/lib/leads/queries";
import { convertLeadToMembership, type ConvertLeadState } from "../../actions";

const initialState: ConvertLeadState = {};

export function ConvertToMembershipDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [state, formAction, isPending] = useActionState(convertLeadToMembership, initialState);
  const who = lead.contact ? contactDisplayName(lead.contact) : "this contact";

  return (
    <Dialog onClose={onClose} labelledBy="convert-to-membership-title">
      <DialogTitle id="convert-to-membership-title">Convert to membership?</DialogTitle>
      <DialogDescription>
        This creates an active membership for {who} and marks this lead as won. A welcome text is sent
        automatically.
      </DialogDescription>

      {state.error ? <p className={`mt-4 ${errorBannerClass}`}>{state.error}</p> : null}
      {state.success ? (
        <p className={`mt-4 ${successBannerClass}`}>
          {state.alreadyMember ? `${who} is already an active member.` : `${who} is now a member.`}
        </p>
      ) : null}

      <form action={formAction}>
        <input type="hidden" name="leadId" value={lead.id} />
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            {state.success ? "Close" : "Cancel"}
          </button>
          {state.success ? null : (
            <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
              {isPending ? "Converting…" : "Convert to Membership"}
            </button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
