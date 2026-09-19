"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { secondaryButtonAutoClass, destructiveGhostButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import { ContactDialog } from "../../_components/contact-dialog";
import { DeleteContactDialog } from "./delete-contact-dialog";

export function ContactActions({ contact }: { contact: Contact }) {
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
        <ContactDialog
          mode="edit"
          contact={contact}
          onClose={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      ) : null}
      {deleteOpen ? <DeleteContactDialog contact={contact} onClose={() => setDeleteOpen(false)} /> : null}
    </div>
  );
}
