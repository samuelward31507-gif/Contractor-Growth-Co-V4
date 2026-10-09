"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { errorBannerClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import type { FounderReview } from "@/lib/founder/model";
import { saveFounderReview } from "../actions";

const FIELDS = [
  { name: "wins", label: "Wins", placeholder: "What moved forward today?" },
  { name: "blockers", label: "Blockers", placeholder: "What's stuck, and what would unstick it?" },
  // Tomorrow's three outcomes are set as structured priorities above the form; this stays as free text.
  { name: "prioritiesNext", label: "Notes for tomorrow", placeholder: "Context for tomorrow morning - who to call first, what to prepare" },
  { name: "notes", label: "Notes", placeholder: "Anything else worth keeping" },
] as const;

/** The daily review for one day - saving again updates that day's review. */
export function ReviewForm({ reviewDate, review }: { reviewDate: string; review: FounderReview | null }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function submit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setMessage(null);
    startTransition(async () => {
      const result = await saveFounderReview(fields);
      setMessage(result.ok ? { tone: "ok", text: "Review saved." } : { tone: "error", text: result.error });
      if (result.ok) router.refresh();
    });
  }

  return (
    <form key={reviewDate} action={submit} className="space-y-4">
      <input type="hidden" name="reviewDate" value={reviewDate} />
      {message?.tone === "error" ? (
        <p className={errorBannerClass} role="alert">
          {message.text}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {FIELDS.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <label htmlFor={`review-${field.name}`} className={labelClass}>{field.label}</label>
            <textarea
              id={`review-${field.name}`}
              name={field.name}
              rows={4}
              maxLength={5000}
              defaultValue={(review?.[field.name] as string | null) ?? ""}
              placeholder={field.placeholder}
              className={inputClass}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3">
        {message?.tone === "ok" ? (
          <span role="status" className="text-sm text-accent-text">
            {message.text}
          </span>
        ) : null}
        <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
          {isPending ? "Saving…" : review ? "Update review" : "Save review"}
        </button>
      </div>
    </form>
  );
}
