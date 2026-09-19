import { primarySectionTitleClass } from "@/lib/ui/typography";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { IncidentActions } from "./incident-actions";

const SEVERITY_CLASS: Record<AutomationIncident["severity"], string> = {
  critical: "bg-red-50 text-red-700",
  warning: "bg-amber-50 text-amber-700",
  info: "bg-slate-100 text-slate-600",
};

const CATEGORY_LABEL: Record<AutomationIncident["category"], string> = {
  workflow_failed: "Workflow failed",
  repeated_workflow_failure: "Repeated failure",
  workflow_stuck: "Execution stuck",
  n8n_dispatch_failed: "n8n dispatch failed",
  n8n_callback_failed: "n8n callback failed",
  sms_send_failed: "SMS send failed",
  sms_delivery_failed: "SMS delivery failed",
};

/**
 * Active incidents (open/acknowledged) for this organization - each row
 * shows severity, issue type, title, first/last seen, occurrence count, and
 * status, per spec. Never renders raw error text beyond the already-
 * sanitized `description` this codebase's own writers guarantee (see
 * lib/automation-health/service.ts's own module comment) - no stack traces,
 * no secrets, no full PII.
 */
export function IncidentList({ incidents }: { incidents: AutomationIncident[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={primarySectionTitleClass}>Active incidents</h2>
      {incidents.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">No active incidents. Automations are running cleanly.</div>
      ) : (
        <div className="-mx-4 overflow-x-auto sm:-mx-6 lg:-mx-10">
          <div className="min-w-[900px] px-4 sm:px-6 lg:px-10">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
                  <th className="py-1.5 pr-4 font-medium">Severity</th>
                  <th className="py-1.5 pr-4 font-medium">Type</th>
                  <th className="py-1.5 pr-4 font-medium">Title</th>
                  <th className="py-1.5 pr-4 font-medium">First seen</th>
                  <th className="py-1.5 pr-4 font-medium">Last seen</th>
                  <th className="py-1.5 pr-4 font-medium">Occurrences</th>
                  <th className="py-1.5 pr-4 font-medium">Status</th>
                  <th className="py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {incidents.map((incident) => (
                  <tr key={incident.id}>
                    <td className="py-2 pr-4">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[incident.severity]}`}>{incident.severity}</span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{CATEGORY_LABEL[incident.category]}</td>
                    <td className="py-2 pr-4 font-medium text-slate-900">
                      {incident.title}
                      {incident.description ? <p className="mt-0.5 text-xs font-normal text-slate-500">{incident.description}</p> : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{new Date(incident.firstSeenAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{new Date(incident.lastSeenAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-700">{incident.occurrenceCount}</td>
                    <td className="py-2 pr-4 text-slate-700 capitalize">{incident.status}</td>
                    <td className="py-2">
                      <IncidentActions incidentId={incident.id} status={incident.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
