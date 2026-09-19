import type { ExecutionDetail, SanitizedObject } from "@/lib/automation/execution-detail";
import { formatDateTime } from "./format";

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-[11px]" : "text-xs"}`}>{value}</p>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: SanitizedObject }) {
  return (
    <div className="col-span-full">
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-700">
        {JSON.stringify(value, null, 2)}
      </pre>
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
 */
export function ExecutionDetailView({ detail }: { detail: ExecutionDetail }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-100 px-4 py-4 sm:grid-cols-4">
      <Field label="Execution ID" value={detail.id} mono />
      <Field label="Automation event ID" value={detail.automationEventId ?? "—"} mono />
      <Field label="Workflow" value={detail.workflowName} mono />
      <Field label="Automation" value={detail.automationName ?? "Unknown"} />
      <Field label="Status" value={detail.status} />
      <Field label="Trigger source" value={detail.triggerSource} />
      <Field label="Attempt" value={String(detail.attempt)} />
      <Field label="Started" value={formatDateTime(detail.startedAt)} />
      <Field label="Completed" value={detail.completedAt ? formatDateTime(detail.completedAt) : "—"} />

      {detail.outboundMessage ? (
        <>
          <Field label="SMS delivery status" value={detail.outboundMessage.status} />
          {detail.outboundMessage.statusReason ? (
            <div className="col-span-full">
              <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Delivery status reason</p>
              <p className="mt-0.5 text-xs text-red-600">
                {detail.outboundMessage.statusReason}
                {detail.outboundMessage.providerErrorCode ? ` (Twilio error ${detail.outboundMessage.providerErrorCode})` : ""}
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {detail.errorMessage ? (
        <div className="col-span-full">
          <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Error</p>
          <p className="mt-0.5 text-xs text-red-600">{detail.errorMessage}</p>
        </div>
      ) : null}

      {detail.metadata ? <JsonBlock label="Metadata (sanitized)" value={detail.metadata} /> : null}
      {detail.payload ? <JsonBlock label="Event payload (sanitized)" value={detail.payload} /> : null}
    </div>
  );
}
