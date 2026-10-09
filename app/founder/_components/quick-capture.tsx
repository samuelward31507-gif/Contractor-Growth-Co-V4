"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { inputClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { quickCaptureFounderItem } from "../actions";

/** Capture a thought in one line - saved as an undated task to sort later (Tasks → All open). */
export function QuickCapture() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function submit(formData: FormData) {
    const title = String(formData.get("title") ?? "");
    setMessage(null);
    startTransition(async () => {
      const result = await quickCaptureFounderItem(title);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      if (inputRef.current) inputRef.current.value = "";
      setMessage({ tone: "ok", text: "Captured. It's in Tasks → All open." });
      router.refresh();
    });
  }

  return (
    <form action={submit} aria-label="Quick capture">
      <div className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor="quick-capture" className="sr-only">Capture a task or idea</label>
      <input ref={inputRef} id="quick-capture" name="title" required maxLength={300} placeholder="Capture a task or idea…" className={`${inputClass} flex-1`} />
      <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
        {isPending ? "Saving…" : "Capture"}
      </button>
      </div>
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${message.tone === "error" ? "text-danger-text" : "text-accent-text"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
