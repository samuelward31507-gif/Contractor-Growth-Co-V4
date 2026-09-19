import { AlertOctagon, AlertTriangle, Info, CircleDashed, Eye, CheckCircle2, type LucideIcon } from "lucide-react";
import { primarySectionTitleClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { IncidentActions } from "./incident-actions";

const SEVERITY_BADGE: Record<AutomationIncident["severity"], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  critical: { label: "Critical", tone: "danger", icon: AlertOctagon },
  warning: { label: "Warning", tone: "warning", icon: AlertTriangle },
  info: { label: "Info", tone: "neutral", icon: Info },
};

const STATUS_BADGE: Record<AutomationIncident["status"], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  open: { label: "Open", tone: "neutral", icon: CircleDashed },
  acknowledged: { label: "Acknowledged", tone: "info", icon: Eye },
  resolved: { label: "Resolved", tone: "success", icon: CheckCircle2 },
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
 *
 * Critical hierarchy without alarm: an active critical row gets a subtle
 * background tint plus the shared Badge's icon+color+text severity chip -
 * unmistakable at a glance, never a flashing banner. Severity is never
 * conveyed by color alone (Badge always pairs a tone with an icon and a
 * text label), so it reads correctly for screen reader users too.
 */
export function IncidentList({ incidents }: { incidents: AutomationIncident[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={primarySectionTitleClass}>Active incidents</h2>
      {incidents.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="All clear" description="No active incidents. Automations are running cleanly." />
      ) : (
        <Panel className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
                  <th className="py-2 pl-4 pr-4 font-medium">Severity</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium">First seen</th>
                  <th className="py-2 pr-4 font-medium">Last seen</th>
                  <th className="py-2 pr-4 font-medium">Occurrences</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {incidents.map((incident) => {
                  const severityBadge = SEVERITY_BADGE[incident.severity];
                  const statusBadge = STATUS_BADGE[incident.status];
                  const isActiveCritical = incident.severity === "critical" && incident.status !== "resolved";
                  return (
                    <tr key={incident.id} className={isActiveCritical ? "bg-red-50/40" : undefined}>
                      <td className="py-2 pl-4 pr-4">
                        <Badge tone={severityBadge.tone} icon={severityBadge.icon}>
                          {severityBadge.label}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{CATEGORY_LABEL[incident.category]}</td>
                      <td className="py-2 pr-4 font-medium text-slate-900">
                        {incident.title}
                        {incident.description ? <p className="mt-0.5 text-xs font-normal text-slate-500">{incident.description}</p> : null}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{new Date(incident.firstSeenAt).toLocaleString()}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-600">{new Date(incident.lastSeenAt).toLocaleString()}</td>
                      <td className="py-2 pr-4 tabular-nums text-slate-700">{incident.occurrenceCount}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                          {statusBadge.label}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <IncidentActions incidentId={incident.id} status={incident.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </section>
  );
}
