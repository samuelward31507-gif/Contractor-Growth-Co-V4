import { CalendarClock, CheckCircle2, CheckCheck, Ban, UserX } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { AppointmentStatus } from "@/lib/appointments/queries";

/**
 * Maps each appointment status onto the shared <Badge> primitive's tone +
 * icon. A deliberate 1:1 mapping across all 5 tones (not a shared "neutral
 * bucket") so scheduled/confirmed/completed/cancelled/no-show stay visually
 * distinct at a glance in the list, not just distinguishable by label text:
 * scheduled (upcoming, not yet confirmed) reads as informational blue,
 * confirmed reads as a positive green, completed recedes to neutral once
 * it's simply historical record, cancelled is an amber "didn't happen" (a
 * lesser concern - could be either party's call), and no-show is the one
 * true problem state (wasted slot, no notice) so it gets the danger red.
 */
export const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, BadgeTone> = {
  scheduled: "info",
  confirmed: "success",
  completed: "neutral",
  cancelled: "warning",
  no_show: "danger",
};

export const APPOINTMENT_STATUS_ICON: Record<AppointmentStatus, LucideIcon> = {
  scheduled: CalendarClock,
  confirmed: CheckCircle2,
  completed: CheckCheck,
  cancelled: Ban,
  no_show: UserX,
};
