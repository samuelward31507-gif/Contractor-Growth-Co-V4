import { OWNER_LABEL, type ActorOwner } from "@/lib/decisions/owner";

/**
 * Batch 3: the one way a surface says whose move it is - a small label
 * before the action ("You", "Trackpr", "Customer"). The contractor's own
 * move is the only one that ever takes the warning tone, and only when it
 * is time-sensitive; Trackpr's work reads in pine (healthy, in motion).
 */
const OWNER_CLASS: Record<ActorOwner, string> = {
  you: "bg-inset text-ink inset-ring-line-strong/80",
  trackpr: "bg-accent-muted text-accent-text inset-ring-accent-border/70",
  customer: "bg-inset text-ink-3 inset-ring-line/80",
};

export function OwnerChip({ owner, urgent = false, className = "" }: { owner: ActorOwner; urgent?: boolean; className?: string }) {
  const tone = owner === "you" && urgent ? "bg-warning-muted text-warning-text inset-ring-warning-border/70" : OWNER_CLASS[owner];
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11px] font-semibold leading-4 inset-ring ${tone} ${className}`}>{OWNER_LABEL[owner]}</span>;
}
