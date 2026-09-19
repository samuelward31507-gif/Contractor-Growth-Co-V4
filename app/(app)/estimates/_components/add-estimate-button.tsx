"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { EstimateDialog } from "./estimate-dialog";

export function AddEstimateButton({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  const [open, setOpen] = useState(false);

  if (contacts.length === 0) {
    return (
      <Link
        href="/contacts"
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        Add a contact first
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
      >
        <Plus aria-hidden className="h-4 w-4" />
        New Estimate
      </button>
      {open ? (
        <EstimateDialog mode="create" contacts={contacts} leads={leads} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
