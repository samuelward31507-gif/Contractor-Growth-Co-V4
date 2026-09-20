"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { primaryButtonAutoClass } from "@/lib/ui/form";
import { ContactDialog } from "./contact-dialog";

export function AddContactButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        Add Contact
      </button>
      {open ? <ContactDialog mode="create" onClose={() => setOpen(false)} /> : null}
    </>
  );
}
