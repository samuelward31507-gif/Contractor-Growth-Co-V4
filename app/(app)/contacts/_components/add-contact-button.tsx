"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { ContactDialog } from "./contact-dialog";

/**
 * `?new=contact` opens this dialog on load - the hook the command menu's
 * "Add contact" action navigates to (`/people?new=contact`, since this
 * button is reused as-is on /people), so that action is real navigation to
 * this real creation flow, not a stub.
 */
export function AddContactButton() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(() => searchParams.get("new") === "contact");

  function close() {
    setOpen(false);
    if (searchParams.get("new") === "contact") router.replace(pathname);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        Add Contact
      </button>
      {open ? <ContactDialog mode="create" onClose={close} /> : null}
    </>
  );
}
