"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarClock } from "lucide-react";
import type { FounderItem } from "@/lib/founder/model";
import { moveFounderItemToDay } from "../actions";

/**
 * Moves one unfinished item to another day - only when clicked; nothing is
 * rescheduled automatically. Sends the item's version, so it can't
 * overwrite a change made elsewhere since the page loaded.
 */
export function MoveToDayButton({ item, dateKey, label }: { item: FounderItem; dateKey: string; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await moveFounderItemToDay(item.id, dateKey, item.updatedAt);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.refresh();
          })
        }
        aria-label={`${label}: ${item.title}`}
        className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-xs font-medium text-ink-2 hover:bg-inset hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
      >
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        {isPending ? "Moving…" : label}
      </button>
      {error ? (
        <span role="alert" className="mt-1 max-w-[16rem] text-right text-xs text-danger-text">
          {error}
        </span>
      ) : null}
    </span>
  );
}
