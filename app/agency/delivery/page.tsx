import Link from "next/link";
import { AlertTriangle, ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getDeliveryOverview } from "@/lib/agency/delivery-queries";
import { LIFECYCLE, LIFECYCLE_LABELS, isOverdue, nextActions, taskGate, todayKey, type DeliveryTask } from "@/lib/agency/delivery";
import { PageHeader } from "@/lib/ui/page-header";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { formatDateKey } from "@/lib/founder/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { DELIVERY_TZ } from "./_components/stage";

/**
 * Client delivery: every confirmed Agency client by lifecycle stage, with
 * the few things worth doing next. Read with the caller's own session (RLS:
 * agency admins only). Live account health is read per client, on the
 * client page - nothing here claims a client is healthy.
 */
export default async function AgencyDeliveryPage() {
  const supabase = await createClient();
  const result = await getDeliveryOverview(supabase);
  const PAGE = `${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`;

  if (!result.ok) {
    return <div className={PAGE}>{result.reason === "not_agency_admin" ? <UnauthorizedState /> : <ErrorState retryHref="/agency/delivery" />}</div>;
  }
  const today = todayKey(DELIVERY_TZ);
  const tasksByClient = new Map<string, DeliveryTask[]>();
  for (const t of result.tasks) tasksByClient.set(t.clientId, [...(tasksByClient.get(t.clientId) ?? []), t]);
  const actions = nextActions(result.clients, result.tasks, today);

  return (
    <div className={PAGE}>
      <PageHeader eyebrow="Agency" title="Client delivery" description="Onboarding, launch and ongoing management for every confirmed Agency client. Launching here records the decision only - it never changes a Trackpr account." />
      {!result.available ? (
        <p role="status" className="text-sm text-ink-3">Client delivery isn&rsquo;t enabled on this database yet.</p>
      ) : result.clients.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No Agency clients yet" description="Clients appear here once a handoff is confirmed on the Client handoffs page." />
      ) : (
        <>
          <StatGrid columns={5}>
            {LIFECYCLE.map((s) => (
              <StatCard key={s} label={LIFECYCLE_LABELS[s]} value={String(result.clients.filter((c) => c.status === s).length)} />
            ))}
          </StatGrid>

          <SectionCard title="Next actions" description="From recorded tasks and stages only.">
            {actions.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing needs action right now.</p>
            ) : (
              <ul className="divide-y divide-line">
                {actions.map((a, i) => (
                  <li key={`${a.clientId}-${a.kind}-${i}`} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/agency/delivery/${a.clientId}`} className="text-sm font-semibold text-ink hover:underline">
                        {a.clientName}
                      </Link>
                      <p className="text-sm text-ink-2">{a.label}</p>
                      <p className="break-words text-xs text-ink-3">{a.detail}</p>
                    </div>
                    {a.kind === "blocked" || a.kind === "overdue" ? (
                      <Badge tone="danger" icon={AlertTriangle}>
                        {a.kind === "blocked" ? "Blocked" : "Overdue"}
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {LIFECYCLE.map((stage) => {
            const clients = result.clients.filter((c) => c.status === stage);
            if (!clients.length) return null;
            return (
              <SectionCard key={stage} title={LIFECYCLE_LABELS[stage]}>
                <ul className="divide-y divide-line">
                  {clients.map((c) => {
                    const own = tasksByClient.get(c.id) ?? [];
                    const gate = taskGate(own);
                    const overdue = own.filter((t) => isOverdue(t, today)).length;
                    return (
                      <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <Link href={`/agency/delivery/${c.id}`} className="text-sm font-semibold text-ink hover:underline">
                            {c.name}
                          </Link>
                          <p className="text-xs text-ink-3">
                            {c.status === "onboarding_not_started" ? "No onboarding plan yet" : `${gate.requiredDone} of ${gate.requiredTotal} required tasks done`}
                            {c.targetLaunchDate ? ` · target launch ${formatDateKey(c.targetLaunchDate, { month: "short", day: "numeric", year: "numeric" })}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {gate.blocked.length ? <Badge tone="danger">{gate.blocked.length} blocked</Badge> : null}
                          {overdue ? <Badge tone="warning">{overdue} overdue</Badge> : null}
                          {c.organizationId ? <Badge tone="neutral">Trackpr account linked</Badge> : <Badge tone="neutral">No Trackpr account linked</Badge>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </SectionCard>
            );
          })}
        </>
      )}
    </div>
  );
}
