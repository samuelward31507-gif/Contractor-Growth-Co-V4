"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { Icon } from "../../../_components/icon";
import { LeadDialog } from "../../_components/lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";

export function LeadActions({ lead, contacts }: { lead: Lead; contacts: Contact[] }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        <Icon name="pencil" className="h-4 w-4" />
        Edit
      </button>
      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
      >
        <Icon name="trash" className="h-4 w-4" />
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
