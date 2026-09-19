"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { secondaryButtonAutoClass, destructiveGhostButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { LeadDialog } from "../../_components/lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";

export function LeadActions({ lead, contacts }: { lead: Lead; contacts: Contact[] }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
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
    </div>
  );
}
