"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import type { ItemKind } from "@/lib/founder/model";
import { ItemDialog, type DealOption, type ItemDefaults } from "./item-dialog";

/** Opens the item dialog; confirms a save with a short status message next to the button. */
export function AddItemButton({
  label = "New item",
  defaultKind = "task",
  defaults,
  deals,
  timeZone,
  variant = "primary",
}: {
  label?: string;
  defaultKind?: ItemKind;
  defaults?: ItemDefaults;
  deals: DealOption[];
  timeZone: string;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  return (
    <span className="inline-flex items-center gap-2">
      {saved ? (
        <span role="status" className="text-sm text-accent-text">
          {saved}
        </span>
      ) : null}
      <button type="button" onClick={() => setOpen(true)} className={variant === "primary" ? primaryButtonAutoClass : secondaryButtonAutoClass}>
        <Plus className="h-4 w-4" aria-hidden />
        {label}
      </button>
      {open ? <ItemDialog defaultKind={defaultKind} defaults={defaults} deals={deals} timeZone={timeZone} onClose={() => setOpen(false)} onSaved={setSaved} /> : null}
    </span>
  );
}
