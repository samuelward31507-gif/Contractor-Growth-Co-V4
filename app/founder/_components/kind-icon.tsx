import { CalendarDays, CircleCheck, Flag, Reply, Users, type LucideIcon } from "lucide-react";
import type { ItemKind } from "@/lib/founder/model";

/** Each item type has its own icon (and label), so types are told apart without relying on color. */
export const KIND_ICON: Record<ItemKind, LucideIcon> = {
  meeting: Users,
  event: CalendarDays,
  task: CircleCheck,
  deadline: Flag,
  follow_up: Reply,
};

export function KindIcon({ kind, className = "h-3.5 w-3.5" }: { kind: ItemKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={`shrink-0 ${className}`} strokeWidth={2} aria-hidden />;
}
