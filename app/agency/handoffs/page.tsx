import Link from "next/link";
import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getAgencyHandoffs } from "@/lib/agency/handoffs";
import { PageHeader } from "@/lib/ui/page-header";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { formatMoney } from "@/lib/founder/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { HandoffControls } from "./_components/handoff-controls";
import { LIFECYCLE_LABELS } from "@/lib/agency/delivery";
import { STAGE_TONE } from "../delivery/_components/stage";

const TZ = "America/Denver";
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Client handoffs: won Founder deals the founder has prepared for delivery,
 * waiting for an agency admin to confirm, and the Agency clients confirmed
 * so far. Read with the caller's own session (RLS: agency admins only).
 * Agency clients here are the Agency's own records - not Trackpr accounts
 * (none is created or linked here) and not contractor customers.
 */
export default async function AgencyHandoffsPage() {
  const supabase = await createClient();
  const result = await getAgencyHandoffs(supabase);
  const PAGE = `${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`;

  if (!result.ok) {
    return <div className={PAGE}>{result.reason === "not_agency_admin" ? <UnauthorizedState /> : <ErrorState retryHref="/agency/handoffs" />}</div>;
  }
  const prepared = result.handoffs.filter((h) => h.status === "prepared");
  const cancelled = result.handoffs.filter((h) => h.status === "cancelled").slice(0, 10);

  return (
    <div className={PAGE}>
      <PageHeader eyebrow="Agency" title="Client handoffs" description="Won deals handed over for delivery. Confirming one creates the Agency client - nothing happens to a Trackpr account." />
      {!result.available ? (
        <p role="status" className="text-sm text-ink-3">Client handoff isn&rsquo;t enabled on this database yet.</p>
      ) : (
        <>
          <SectionCard title="Awaiting confirmation" description="Prepared by the founder from a won deal. Review the terms and scope, then confirm or cancel.">
            {prepared.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing waiting. Handoffs appear here when a won deal is prepared in the Founder deals page.</p>
            ) : (
              <ul className="divide-y divide-line">
                {prepared.map((h) => (
                  <li key={h.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{h.clientName}</p>
                      <p className="text-xs text-ink-3">
                        {h.contactName} · {formatMoney(h.setupFee, h.currency)} setup + {formatMoney(h.monthlyFee, h.currency)}/mo agreed · prepared {when(h.preparedAt)}
                      </p>
                      <p className="mt-1 line-clamp-2 text-sm text-ink-2">{h.scope}</p>
                    </div>
                    <div className="shrink-0">
                      <HandoffControls handoff={h} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Agency clients" description="Created by confirming a handoff. Open a client to start onboarding and track delivery.">
            {result.clients.length === 0 ? (
              <EmptyState icon={UserPlus} title="No Agency clients yet" description="Confirm a handoff above to create the first one." />
            ) : (
              <ul className="divide-y divide-line">
                {result.clients.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                    <div className="min-w-0">
                      <Link href={`/agency/delivery/${c.id}`} className="text-sm font-semibold text-ink hover:underline">
                        {c.name}
                      </Link>
                      <p className="text-xs text-ink-3">
                        {c.contactName} · {[c.contactEmail, c.contactPhone].filter(Boolean).join(" · ")}
                      </p>
                      <p className="text-xs text-ink-3">
                        {formatMoney(c.setupFee, c.currency)} setup + {formatMoney(c.monthlyFee, c.currency)}/mo agreed · created {when(c.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={STAGE_TONE[c.status] ?? "neutral"}>{LIFECYCLE_LABELS[c.status] ?? c.status}</Badge>
                      {c.organizationId ? null : <Badge tone="neutral">No Trackpr account linked</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {cancelled.length ? (
            <SectionCard title="Recently cancelled">
              <ul className="divide-y divide-line">
                {cancelled.map((h) => (
                  <li key={h.id} className="py-2 text-sm">
                    <span className="font-medium text-ink">{h.clientName}</span>
                    <span className="text-ink-3"> · cancelled {h.cancelledAt ? when(h.cancelledAt) : ""}: {h.cancelReason}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}
