"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle } from "lucide-react";
import { resolveFailedFollowupAction } from "@/app/(app)/leads/actions";
import { SectionCard } from "@/lib/ui/section-card";
import { secondaryButtonSmallClass } from "@/lib/ui/form";
import { metaClass } from "@/lib/ui/typography";

export type FailedFollowupItem = { id: string; leadId: string; failedTouch: number; updatedAt: string };

/**
 * Audit: follow-ups that stopped after a failure and wait for a person. Two
 * honest choices (lib/followups/recovery.ts) - there is deliberately no
 * "retry": the failed message is never re-sent. The server action re-checks
 * admin rights; non-admins see the list without controls.
 */
export function FailedFollowups({ items, canManage }: { items: FailedFollowupItem[]; canManage: boolean }) {
  if (items.length === 0) return null;
  return (
    <SectionCard title="Follow-ups that need review" icon={AlertTriangle}>
      <p className={metaClass}>
        These stopped after a message could not be sent. Skip moves on to the next message on its normal schedule (the failed one is not
        re-sent); Stop ends the follow-up for that lead.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <FailedFollowupRow key={item.id} item={item} canManage={canManage} />
        ))}
      </ul>
    </SectionCard>
  );
}

function FailedFollowupRow({ item, canManage }: { item: FailedFollowupItem; canManage: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = (resolution: "stop" | "skip") =>
    startTransition(async () => {
      const result = await resolveFailedFollowupAction(item.id, resolution);
      if (result.ok) {
        setError(null);
        setMessage(result.message);
      } else {
        setError(result.error);
      }
    });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div>
        <Link href={`/leads/${item.leadId}`} className="text-sm font-medium text-ink hover:underline">
          View lead
        </Link>
        <p className={metaClass}>Message {item.failedTouch} could not be sent.</p>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? <p className="text-sm text-ink">{message}</p> : null}
      </div>
      {canManage && !message ? (
        <div className="flex gap-2">
          <button type="button" className={secondaryButtonSmallClass} disabled={isPending} onClick={() => resolve("skip")}>
            Skip this message
          </button>
          <button type="button" className={secondaryButtonSmallClass} disabled={isPending} onClick={() => resolve("stop")}>
            Stop follow-up
          </button>
        </div>
      ) : null}
    </li>
  );
}
