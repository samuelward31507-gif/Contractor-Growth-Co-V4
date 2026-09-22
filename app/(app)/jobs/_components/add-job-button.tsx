"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { JobDialog } from "./job-dialog";

/** Growth System Completion Pass 1: mirrors app/(app)/appointments/_components/add-appointment-button.tsx exactly. */
export function AddJobButton({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
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
        <Plus aria-hidden className="h-4 w-4" />
        New Job
      </button>
      {open ? <JobDialog contacts={contacts} leads={leads} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
