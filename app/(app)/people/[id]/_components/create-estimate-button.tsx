"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileSearch } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { EstimateDialog } from "../../../estimates/_components/estimate-dialog";

/**
 * Final Major Product Build (Customer Command Center): "Create Estimate"
 * alongside Call/Text in the Person page's own header actions - the real
 * create-estimate dialog (app/(app)/estimates/_components/estimate-dialog.tsx),
 * reused as-is with this contact pre-selected, not a second implementation.
 * router.refresh() after a successful create is this page's own way of
 * picking up the new estimate (this page has no `?new=estimate` query param
 * to key a close-and-strip-param effect off of, unlike AddEstimateButton on
 * /estimates itself) - the estimate then shows up in "What happened" and the
 * Estimates section below without a manual reload.
 */
export function CreateEstimateButton({ contactId, contacts, leads }: { contactId: string; contacts: Contact[]; leads: Lead[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function close() {
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${secondaryButtonAutoClass} gap-1.5`}>
        <FileSearch className="h-4 w-4" aria-hidden />
        Create Estimate
      </button>
      {open ? <EstimateDialog mode="create" contacts={contacts} leads={leads} defaultContactId={contactId} onClose={close} /> : null}
    </>
  );
}
