import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/appointments/format";
import type { AppointmentStatus } from "@/lib/appointments/queries";

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE_CLASS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
