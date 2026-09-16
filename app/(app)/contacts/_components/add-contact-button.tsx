"use client";

import { useState } from "react";
import { Icon } from "../../_components/icon";
import { ContactDialog } from "./contact-dialog";

export function AddContactButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
      >
        <Icon name="plus" className="h-4 w-4" />
        Add Contact
      </button>
      {open ? <ContactDialog mode="create" onClose={() => setOpen(false)} /> : null}
    </>
  );
}
