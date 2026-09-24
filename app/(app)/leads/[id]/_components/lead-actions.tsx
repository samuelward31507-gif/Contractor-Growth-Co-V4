"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2, UserCheck } from "lucide-react";
import type { OrganizationVertical } from "@/lib/auth/organization";
import { secondaryButtonAutoClass, destructiveGhostButtonAutoClass, primaryButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { LeadDialog } from "../../_components/lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import { ConvertToMembershipDialog } from "./convert-to-membership-dialog";

export function LeadActions({ lead, contacts, vertical }: { lead: Lead; contacts: Contact[]; vertical: OrganizationVertical }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const router = useRouter();

  // Gym Revenue Engine, Slice 2: never rendered for a contractor
  // organization - this is a UI convenience only, not the authorization
  // boundary (convertLeadToMembership itself independently re-verifies
  // vertical === "gym" server-side before doing anything).
  const showConvert = vertical === "gym" && lead.status !== "won";

  return (
    <div className="flex items-center gap-2">
      {showConvert ? (
        <button type="button" onClick={() => setConvertOpen(true)} className={primaryButtonAutoClass}>
          <UserCheck className="h-4 w-4" aria-hidden />
          Convert to Membership
        </button>
      ) : null}
      {/* Secondary/destructive-ghost pairing (lib/ui/form.ts) so Delete
          recedes until intentionally reached for, rather than competing
          with Edit for attention. */}
      <button type="button" onClick={() => setEditOpen(true)} className={secondaryButtonAutoClass}>
        <Pencil className="h-4 w-4" aria-hidden />
        Edit
      </button>
      <button type="button" onClick={() => setDeleteOpen(true)} className={destructiveGhostButtonAutoClass}>
        <Trash2 className="h-4 w-4" aria-hidden />
        Delete
      </button>

      {editOpen ? (
        <LeadDialog
          mode="edit"
          lead={lead}
          contacts={contacts}
          onClose={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      ) : null}
      {deleteOpen ? <DeleteLeadDialog lead={lead} onClose={() => setDeleteOpen(false)} /> : null}
      {convertOpen ? (
        <ConvertToMembershipDialog
          lead={lead}
          onClose={() => {
            setConvertOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
