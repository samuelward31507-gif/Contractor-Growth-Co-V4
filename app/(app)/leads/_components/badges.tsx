import { STATUS_BADGE_CLASS, STATUS_LABELS, TEMPERATURE_BADGE_CLASS, TEMPERATURE_LABELS } from "@/lib/leads/format";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";

const BASE_CLASS = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium";

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <span className={`${BASE_CLASS} ${STATUS_BADGE_CLASS[status]}`}>{STATUS_LABELS[status]}</span>;
}

export function TemperatureBadge({ temperature }: { temperature: LeadTemperature }) {
  return (
    <span className={`${BASE_CLASS} ${TEMPERATURE_BADGE_CLASS[temperature]}`}>
      {TEMPERATURE_LABELS[temperature]}
    </span>
  );
}
