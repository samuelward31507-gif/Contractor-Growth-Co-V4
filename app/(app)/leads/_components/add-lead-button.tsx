"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { LeadDialog } from "./lead-dialog";

export function AddLeadButton({ contacts }: { contacts: Contact[] }) {
  const [open, setOpen] = useState(false);

  if (contacts.length === 0) {
    return (
      <Link href="/contacts" className={secondaryButtonAutoClass}>
        Add a contact first
      </Link>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        Add Lead
      </button>
      {open ? <LeadDialog mode="create" contacts={contacts} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
