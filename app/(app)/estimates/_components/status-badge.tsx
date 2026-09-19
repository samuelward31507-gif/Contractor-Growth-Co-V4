import { STATUS_DOT_CLASS, STATUS_LABELS } from "@/lib/estimates/format";
import type { EstimateStatus } from "@/lib/estimates/queries";

export function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
