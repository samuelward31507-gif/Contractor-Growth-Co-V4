"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { LeadDialog } from "./lead-dialog";

/** `?new=lead` opens this dialog on load - the command menu's "Add lead" action navigates to /people?view=leads&new=lead (Final Batch 3); Today's header renders it too. */
export function AddLeadButton({ contacts }: { contacts: Contact[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(() => searchParams.get("new") === "lead");

  function close() {
    setOpen(false);
    if (searchParams.get("new") === "lead") {
      // Final Batch 3: drop only `new` - keep the view the dialog was opened from (e.g. view=leads).
      const rest = new URLSearchParams(searchParams.toString());
      rest.delete("new");
      const query = rest.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    }
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
        <Plus className="h-4 w-4" aria-hidden />
        Add Lead
      </button>
      {open ? <LeadDialog mode="create" contacts={contacts} onClose={close} /> : null}
    </>
  );
}
