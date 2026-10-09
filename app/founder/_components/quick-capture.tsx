"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { inputClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { quickCaptureFounderItem } from "../actions";

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}

/**
 * Capture an obligation in one line: a title and, optionally, the day it's
 * due - details can be added later. Each capture carries a one-time id, so
 * a double-click or a retry can't create it twice; a fresh id is issued
 * only after a successful save.
 */
export function QuickCapture() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [clientId, setClientId] = useState(newClientId);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function submit(formData: FormData) {
    const title = String(formData.get("title") ?? "");
    const dueDate = String(formData.get("dueDate") ?? "");
    setMessage(null);
    startTransition(async () => {
      const result = await quickCaptureFounderItem(title, { dueDate, clientId });
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      formRef.current?.reset();
      setClientId(newClientId());
      setMessage({ tone: "ok", text: dueDate ? "Captured - it's on your calendar." : "Captured. Find it in Tasks → All open." });
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={submit} aria-label="Quick capture">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="quick-capture" className="sr-only">Capture a task</label>
        <input id="quick-capture" name="title" required maxLength={300} placeholder="Capture a task…" className={`${inputClass} min-w-0 flex-1`} />
        <div className="flex gap-2">
          <label htmlFor="quick-capture-due" className="sr-only">Due date (optional)</label>
          <input id="quick-capture-due" name="dueDate" type="date" title="Due date (optional)" className={`${inputClass} w-full sm:w-40`} />
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : "Capture"}
          </button>
        </div>
      </div>
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${message.tone === "error" ? "text-danger-text" : "text-accent-text"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
