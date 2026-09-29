import { ChevronRight, CircleDashed, Eye, CheckCircle2, type LucideIcon } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { GENERIC_INCIDENT_LABEL, INCIDENT_LABEL, INCIDENT_SENTENCE, SELF_DESCRIBING_INCIDENT_CATEGORIES } from "@/lib/ui/incident-language";
import { StatusLabel, type StatusDotTone } from "@/lib/ui/status-dot";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import { formatRelativeTime } from "./format";
import { IncidentActions } from "./incident-actions";

const SEVERITY: Record<AutomationIncident["severity"], { label: string; tone: StatusDotTone }> = {
  critical: { label: "Critical", tone: "critical" },
  warning: { label: "Warning", tone: "attention" },
  info: { label: "Info", tone: "neutral" },
};

const STATUS_BADGE: Record<AutomationIncident["status"], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  open: { label: "Open", tone: "neutral", icon: CircleDashed },
  acknowledged: { label: "Acknowledged", tone: "info", icon: Eye },
  resolved: { label: "Resolved", tone: "success", icon: CheckCircle2 },
};

// Trackpr 2.0 (step 2D): category labels come from the shared
// contractor-language map (lib/ui/incident-language.ts) the top bar's
// status also uses - no infrastructure names ("n8n", "SMS", "execution"),
// and a neutral label for a category the map doesn't know.
const CATEGORY_LABEL = INCIDENT_LABEL;

/**
 * Trackpr 2.0 (step 2G): what the row leads with. A known category leads
 * with its plain-language sentence - the backend's own title/description for
 * those categories is infrastructure wording ("...execution stuck", a raw
 * error), so it moves into a collapsed "Technical details" disclosure for
 * operators rather than being dropped. A category this map doesn't know
 * (a newer backend's), or one whose backend wording is already plain
 * business language (SELF_DESCRIBING_INCIDENT_CATEGORIES - Phase 1C's
 * payment reconciliation), keeps its own title and description as the
 * visible explanation.
 */
function presentIncident(incident: AutomationIncident) {
  const selfDescribing = SELF_DESCRIBING_INCIDENT_CATEGORIES.has(incident.category);
  const sentence = selfDescribing ? undefined : (INCIDENT_SENTENCE as Record<string, string | undefined>)[incident.category];
  const automationName = incident.automationId ? (getAutomationDefinition(incident.automationId)?.name ?? null) : null;
  if (sentence) {
    return { headline: sentence, detail: null as string | null, technical: [incident.title, incident.description].filter(Boolean).join(" - "), automationName };
  }
  return { headline: incident.title, detail: incident.description, technical: null as string | null, automationName };
}

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
      <p className={sectionLabelClass}>Issues</p>
      {incidents.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="All clear" description="No open issues. Your automations are running normally." />
      ) : (
        <Panel className="overflow-hidden p-0">
          <ul className="divide-y divide-line">
            {incidents.map((incident) => {
              const severity = SEVERITY[incident.severity];
              const statusBadge = STATUS_BADGE[incident.status];
              const view = presentIncident(incident);
              return (
                <li key={incident.id}>
                  <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{view.headline}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <StatusLabel tone={severity.tone}>{severity.label}</StatusLabel>
                        <span className="text-ink-4" aria-hidden>
                          ·
                        </span>
                        <span className="text-ink-3">{CATEGORY_LABEL[incident.category] ?? GENERIC_INCIDENT_LABEL}</span>
                        <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                          {statusBadge.label}
                        </Badge>
                      </div>
                      {view.automationName ? <p className="mt-1.5 text-[13px] text-ink-2">Affects {view.automationName}</p> : null}
                      {view.detail ? <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{view.detail}</p> : null}
                      <p className="mt-1.5 text-xs text-ink-3">
                        First seen {formatRelativeTime(incident.firstSeenAt)} · Last seen {formatRelativeTime(incident.lastSeenAt)} ·{" "}
                        <span className="tabular-nums">{incident.occurrenceCount}</span> occurrence{incident.occurrenceCount === 1 ? "" : "s"}
                      </p>
                      {view.technical ? (
                        <details className="group mt-1.5">
                          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-ink-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden />
                            Technical details
                          </summary>
                          <p className="mt-1 break-words rounded-md bg-inset px-3 py-2 text-xs text-ink-2">{view.technical}</p>
                        </details>
                      ) : null}
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
