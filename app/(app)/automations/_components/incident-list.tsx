import { AlertOctagon, AlertTriangle, Info, CircleDashed, Eye, CheckCircle2, type LucideIcon } from "lucide-react";
import { primarySectionTitleClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { formatRelativeTime } from "./format";
import { IncidentActions } from "./incident-actions";

const SEVERITY_ICON: Record<AutomationIncident["severity"], LucideIcon> = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
};

const SEVERITY_STYLE: Record<AutomationIncident["severity"], string> = {
  critical: "bg-red-50 text-red-600",
  warning: "bg-amber-50 text-amber-600",
  info: "bg-slate-100 text-slate-500",
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
 * Trackpr 2.0 Phase 4: moved from the retired /automation-health route and
 * rebuilt as a stacked row list instead of its original min-w-[900px] table
 * - that table forced horizontal scroll on mobile, which the consolidation
 * brief explicitly calls out to avoid. Same data, same columns' worth of
 * information (severity, category, title/description, first/last seen,
 * occurrence count, status, actions), same acknowledgeIncident/
 * resolveIncident actions - only the layout changed, matching
 * AttentionPanel/AutomationList's existing responsive row convention rather
 * than inventing a new pattern.
 *
 * Never renders raw error text beyond the already-sanitized `description`
 * this codebase's own writers guarantee (see lib/automation-health/
 * service.ts) - no stack traces, no secrets, no full PII.
 */
export function IncidentList({ incidents }: { incidents: AutomationIncident[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={primarySectionTitleClass}>Active incidents</h2>
      {incidents.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="All clear" description="No active incidents. Automations are running cleanly." />
      ) : (
        <Panel className="overflow-hidden p-0">
          <ul className="divide-y divide-slate-100">
            {incidents.map((incident) => {
              const SeverityIcon = SEVERITY_ICON[incident.severity];
              const statusBadge = STATUS_BADGE[incident.status];
              const isActiveCritical = incident.severity === "critical" && incident.status !== "resolved";
              return (
                <li key={incident.id} className={isActiveCritical ? "bg-red-50/40" : undefined}>
                  <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${SEVERITY_STYLE[incident.severity]}`}>
                        <SeverityIcon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900">{incident.title}</p>
                          <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                            {statusBadge.label}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {CATEGORY_LABEL[incident.category]}
                          {incident.description ? ` · ${incident.description}` : ""}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          First seen {formatRelativeTime(incident.firstSeenAt)} · Last seen {formatRelativeTime(incident.lastSeenAt)} ·{" "}
                          {incident.occurrenceCount} occurrence{incident.occurrenceCount === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 sm:pl-3">
                      <IncidentActions incidentId={incident.id} status={incident.status} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </section>
  );
}
