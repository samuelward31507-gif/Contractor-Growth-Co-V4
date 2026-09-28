"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { EstimateDialog } from "./estimate-dialog";

/**
 * `?new=estimate` opens this dialog on load - the command menu's "Create
 * estimate" action navigates here. `?contactId=` additionally pre-fills the
 * contact picker - the real destination behind "Create estimate" opportunity
 * actions (see opportunityActionHref in
 * app/(app)/opportunities/_components/opportunity-type.ts) and the Person
 * page's own Create Estimate button, so a contractor acting on a specific
 * customer never has to re-search for them here.
 */
export function AddEstimateButton({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(() => searchParams.get("new") === "estimate");
  const defaultContactId = searchParams.get("contactId") ?? undefined;

  function close() {
    setOpen(false);
    if (searchParams.get("new") === "estimate") router.replace(pathname);
  }

  if (contacts.length === 0) {
    return (
      <Link href="/people" className={secondaryButtonAutoClass}>
        Add a contact first
      </Link>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus aria-hidden className="h-4 w-4" />
        New Estimate
      </button>
      {open ? <EstimateDialog mode="create" contacts={contacts} leads={leads} defaultContactId={defaultContactId} onClose={close} /> : null}
    </>
  );
}
