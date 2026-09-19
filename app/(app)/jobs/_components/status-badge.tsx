import { STATUS_DOT_CLASS, STATUS_LABELS } from "@/lib/jobs/format";
import type { JobStatus } from "@/lib/jobs/queries";

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
