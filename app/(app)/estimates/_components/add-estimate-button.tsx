"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { EstimateDialog } from "./estimate-dialog";

/** `?new=estimate` opens this dialog on load - the command menu's "Create estimate" action navigates here. */
export function AddEstimateButton({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(() => searchParams.get("new") === "estimate");

  function close() {
    setOpen(false);
    if (searchParams.get("new") === "estimate") router.replace(pathname);
  }

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
        New Estimate
      </button>
      {open ? <EstimateDialog mode="create" contacts={contacts} leads={leads} onClose={close} /> : null}
    </>
  );
}
