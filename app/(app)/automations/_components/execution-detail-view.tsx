import { CheckCircle2, XCircle, Loader2, CircleSlash } from "lucide-react";
import type { ExecutionDetail, SanitizedObject } from "@/lib/automation/execution-detail";
import { formatDateTime } from "./format";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";

const STATUS_BADGE: Record<ExecutionDetail["status"], { label: string; tone: BadgeTone; icon: typeof CheckCircle2 }> = {
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  running: { label: "Running", tone: "info", icon: Loader2 },
  cancelled: { label: "Cancelled", tone: "neutral", icon: CircleSlash },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={detailLabelClass}>{label}</p>
      <div className={detailValueClass}>{children}</div>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: SanitizedObject }) {
  return (
    <div className="col-span-full">
      <p className={detailLabelClass}>{label}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-700">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/**
 * Renders only what getExecutionDetail (lib/automation/execution-detail.ts)
 * already sanitized - never receives or touches a raw database row. Every
 * field here is either a plain scalar (id/status/timestamps) or a value
 * that already passed sanitizeForDisplay() (metadata/payload) - there is no
 * path in this component that could render a secret even if one somehow
 * ended up in a jsonb column, since the redaction happened before this
 * component ever saw the data.
 *
 * Design brief: don't expose raw implementation details (execution ids,
 * workflow names, raw JSON) to a non-technical contractor by default. The
 * human-relevant facts (what happened, when, and why it failed) lead; the
 * identifiers and raw payload/metadata a support engineer might need are
 * tucked behind a native <details> disclosure instead of removed - the
 * capability to inspect them is preserved, just not front-and-center.
 */
export function ExecutionDetailView({ detail }: { detail: ExecutionDetail }) {
  const statusBadge = STATUS_BADGE[detail.status];

  return (
    <div className="border-t border-slate-100 px-4 py-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Field label="Automation">{detail.automationName ?? "Unknown"}</Field>
        <Field label="Status">
          <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
            {statusBadge.label}
          </Badge>
        </Field>
        <Field label="Attempt">{String(detail.attempt)}</Field>
        <Field label="Started">{formatDateTime(detail.startedAt)}</Field>
        <Field label="Completed">{detail.completedAt ? formatDateTime(detail.completedAt) : "—"}</Field>

        {detail.outboundMessage ? <Field label="SMS delivery status">{detail.outboundMessage.status}</Field> : null}

        {detail.outboundMessage?.statusReason ? (
          <div className="col-span-full">
            <p className={detailLabelClass}>Delivery status reason</p>
            <p className="mt-1 text-sm text-red-600">
              {detail.outboundMessage.statusReason}
              {detail.outboundMessage.providerErrorCode ? ` (provider error ${detail.outboundMessage.providerErrorCode})` : ""}
            </p>
          </div>
        ) : null}

        {detail.errorMessage ? (
          <div className="col-span-full">
            <p className={detailLabelClass}>Error</p>
            <p className="mt-1 text-sm text-red-600">{detail.errorMessage}</p>
          </div>
        ) : null}
      </div>

      <details className="mt-4 border-t border-slate-100 pt-3">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10">
          Technical details
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Field label="Execution ID">
            <span className="break-all font-mono text-xs text-slate-600">{detail.id}</span>
          </Field>
          <Field label="Automation event ID">
            <span className="break-all font-mono text-xs text-slate-600">{detail.automationEventId ?? "—"}</span>
          </Field>
          <Field label="Workflow">
            <span className="break-all font-mono text-xs text-slate-600">{detail.workflowName}</span>
          </Field>
          {detail.metadata ? <JsonBlock label="Metadata (sanitized)" value={detail.metadata} /> : null}
          {detail.payload ? <JsonBlock label="Event payload (sanitized)" value={detail.payload} /> : null}
        </div>
      </details>
    </div>
  );
}
