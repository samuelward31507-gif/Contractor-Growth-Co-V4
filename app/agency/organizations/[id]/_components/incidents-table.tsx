import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { Table, TableHeadCell, TableBody, TableCell } from "@/lib/ui/table";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { formatCount } from "../../../_components/format";
import { SectionEmpty } from "./section-empty";

const SEVERITY_TONE: Record<AutomationIncident["severity"], BadgeTone> = {
  critical: "danger",
  warning: "warning",
  info: "neutral",
};

const RAIL: Record<AutomationIncident["severity"], string> = {
  critical: "border-l-danger",
  warning: "border-l-warning",
  info: "border-l-transparent",
};

const COLUMNS = "grid-cols-[minmax(0,1fr)_100px_190px_110px]";

function occurrences(count: number): string {
  return `${formatCount(count)} occurrence${count === 1 ? "" : "s"}`;
}

/**
 * Open or acknowledged automation incidents for this client, already
 * severity-sorted by listIncidents. `unavailable` is the health read's own
 * incidentsUnavailable flag: when it is set an empty list is NOT a
 * confirmed "no incidents", so the empty copy says so instead.
 */
export function IncidentsTable({ incidents, unavailable }: { incidents: AutomationIncident[]; unavailable: boolean }) {
  if (incidents.length === 0) {
    return unavailable ? (
      <SectionEmpty title="Incidents couldn't be read for this client." description="This is not a confirmed zero - check again shortly." />
    ) : (
      <SectionEmpty title="No active operational incidents for this organization." description="Open and acknowledged incidents appear here as soon as one is raised." />
    );
  }

  return (
    <>
      <div className="lg:-mx-3.5">
        <Table columns={COLUMNS}>
          <TableHeadCell>Incident</TableHeadCell>
          <TableHeadCell>Severity</TableHeadCell>
          <TableHeadCell>First seen</TableHeadCell>
          <TableHeadCell align="right">Occurrences</TableHeadCell>
        </Table>
        <TableBody>
          {incidents.map((incident) => (
            <div key={incident.id} className={`grid min-h-12 ${COLUMNS} items-center gap-6 border-l-2 py-2.5 pl-3 pr-4 ${RAIL[incident.severity]}`}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{incident.title}</span>
                <span className="block text-xs capitalize text-ink-3">{incident.status}</span>
              </span>
              <span>
                <Badge tone={SEVERITY_TONE[incident.severity]}>{incident.severity}</Badge>
              </span>
              <TableCell muted>{new Date(incident.firstSeenAt).toLocaleString()}</TableCell>
              <TableCell align="right">{formatCount(incident.occurrenceCount)}</TableCell>
            </div>
          ))}
        </TableBody>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {incidents.map((incident) => (
          <li key={incident.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-ink">{incident.title}</p>
              <p className="mt-0.5 text-xs text-ink-3">
                First seen {new Date(incident.firstSeenAt).toLocaleString()} · {occurrences(incident.occurrenceCount)}
              </p>
            </div>
            <Badge tone={SEVERITY_TONE[incident.severity]}>{incident.severity}</Badge>
          </li>
        ))}
      </ul>
    </>
  );
}
