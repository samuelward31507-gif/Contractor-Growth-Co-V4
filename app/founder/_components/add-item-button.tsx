"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import type { ItemKind } from "@/lib/founder/model";
import { ItemDialog, type DealOption } from "./item-dialog";

export function AddItemButton({ label = "New item", defaultKind = "task", deals, timeZone, variant = "primary" }: { label?: string; defaultKind?: ItemKind; deals: DealOption[]; timeZone: string; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={variant === "primary" ? primaryButtonAutoClass : secondaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        {label}
      </button>
      {open ? <ItemDialog defaultKind={defaultKind} deals={deals} timeZone={timeZone} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
