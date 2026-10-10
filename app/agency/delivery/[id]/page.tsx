import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getDeliveryClient, getLinkableOrganizations, getLinkedSignals, type LiveSignalsResult } from "@/lib/agency/delivery-queries";
import {
  LIFECYCLE_LABELS,
  SERVICE_MODULE_LABELS,
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_STATUS_LABELS,
  isOverdue,
  launchBlockers,
  liveHealth,
  readinessChecks,
  taskGate,
  todayKey,
  type DeliveryEvent,
  type DeliveryTask,
  type ReadinessCheck,
} from "@/lib/agency/delivery";
import { DetailHeader } from "@/lib/ui/detail-header";
import { SectionCard } from "@/lib/ui/section-card";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { formatDateKey, formatMoney } from "@/lib/format/operator";
import { UnauthorizedState } from "../../_components/unauthorized-state";
import { ErrorState } from "../../_components/error-state";
import { CHECK_LABEL, CHECK_TONE, DELIVERY_TZ, STAGE_TONE, formatWhen } from "../_components/stage";
import {
  AddServicesForm,
  AddTaskForm,
  ApproveLaunchButton,
  ClientDetailsForm,
  LinkAccountForm,
  MarkReadyButton,
  MoveToOngoingButton,
  StartOnboardingForm,
  TaskControls,
} from "../_components/delivery-controls";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_TONE: Record<DeliveryTask["status"], BadgeTone> = { todo: "neutral", in_progress: "info", blocked: "danger", done: "success", wont_do: "neutral" };
const day = (key: string) => formatDateKey(key, { month: "short", day: "numeric", year: "numeric" });

const EVENT_LABELS: Record<string, string> = {
  onboarding_started: "Onboarding started",
  services_added: "Modules added",
  task_added: "Task added",
  task_status_changed: "Task status changed",
  task_details_changed: "Task owner / due date changed",
  details_changed: "Owner / target date changed",
  ready_to_launch: "Marked ready to launch",
  readiness_lost: "No longer ready to launch",
  launched: "Launch approved",
  moved_to_ongoing: "Moved to ongoing management",
  organization_linked: "Trackpr account linked",
};

/**
 * One Agency client's delivery: agreed terms (read-only), lifecycle, tasks,
 * readiness, launch and live health. Every read is the caller's own session
 * except the linked account's live signals, which are read with the service
 * client only after the admin check AND only for an account confirmed to be
 * Agency-managed. Nothing on this page changes a Trackpr account.
 */
export default async function AgencyDeliveryClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const PAGE = `${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const result = await getDeliveryClient(supabase, id);
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    return <div className={PAGE}>{result.reason === "not_agency_admin" ? <UnauthorizedState /> : <ErrorState retryHref={`/agency/delivery/${id}`} />}</div>;
  }
  if (!result.available) {
    return (
      <div className={PAGE}>
        <p role="status" className="text-sm text-ink-3">Client delivery isn&rsquo;t enabled on this database yet.</p>
      </div>
    );
  }
  const { client, tasks, events, launch, admins } = result.detail;

  // Admin confirmed above. A missing service configuration reads as unavailable, never as healthy.
  let live: LiveSignalsResult;
  let linkable: { organizationId: string; organizationName: string }[] | null = null;
  try {
    const service = createServiceRoleClient();
    live = await getLinkedSignals(service, client.organizationId);
    if (!client.organizationId) {
      const orgs = await getLinkableOrganizations(supabase, service);
      linkable = orgs.ok ? orgs.organizations : null;
    }
  } catch {
    live = { signals: client.organizationId ? { kind: "unavailable", organizationId: client.organizationId } : { kind: "not_linked" }, incidents: null };
  }

  const today = todayKey(DELIVERY_TZ);
  const gate = taskGate(tasks);
  const checks = readinessChecks(client, tasks, live.signals);
  const blockers = launchBlockers(checks);
  const health = liveHealth(live.signals);
  const who = (userId: string | null) => (userId ? (admins.find((a) => a.userId === userId)?.email ?? "Former agency admin") : "Removed account");
  const started = client.status !== "onboarding_not_started";

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader
        eyebrow="Agency client"
        backHref="/agency/delivery"
        backLabel="Back to Client delivery"
        title={client.name}
        badges={
          <>
            <Badge tone={STAGE_TONE[client.status]}>{LIFECYCLE_LABELS[client.status]}</Badge>
            {client.organizationId ? <Badge tone="neutral">Trackpr account linked</Badge> : <Badge tone="neutral">No Trackpr account linked</Badge>}
          </>
        }
        meta={
          <p className="text-xs text-ink-3">
            {started ? `${gate.requiredDone} of ${gate.requiredTotal} required tasks done` : "Onboarding not started"}
            {client.targetLaunchDate ? ` · target launch ${day(client.targetLaunchDate)}` : ""}
            {client.ownerUserId ? ` · owner ${who(client.ownerUserId)}` : " · no owner"}
          </p>
        }
      />

      <div className={PAGE}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            <SectionCard title="Stage" description={stageDescription(client.status)}>
              {client.status === "onboarding_not_started" ? <StartOnboardingForm client={client} admins={admins} /> : null}
              {client.status === "onboarding" ? (
                <MarkReadyButton client={client} gatePasses={gate.passes} reason={`${gate.requiredDone} of ${gate.requiredTotal} required tasks done${gate.blocked.length ? `, ${gate.blocked.length} blocked` : ""}. Every required task must be done and nothing blocked.`} />
              ) : null}
              {client.status === "ready_to_launch" ? (
                <div className="space-y-2">
                  <ApproveLaunchButton client={client} checks={checks} />
                  {blockers.length ? <p className="text-xs font-medium text-danger-text">Blocked by: {blockers.map((b) => b.label).join("; ")}</p> : null}
                </div>
              ) : null}
              {client.status === "live" ? <MoveToOngoingButton client={client} /> : null}
              {client.status === "ongoing_management" ? <p className="text-sm text-ink-2">Launched and under ongoing management.</p> : null}
            </SectionCard>

            {started ? (
              <SectionCard title="Launch readiness" description="Passed and Failed come from recorded tasks and the linked account. Unverified means this system can't confirm it - it needs a written acknowledgement at launch.">
                <ReadinessList checks={checks} />
              </SectionCard>
            ) : null}

            {started ? (
              <SectionCard title="Onboarding tasks" description={`${gate.requiredDone} of ${gate.requiredTotal} required done · ${gate.blocked.length} blocked · ${gate.clientInputsOpen.length} waiting on the client`} action={<AddTaskForm clientId={client.id} admins={admins} />}>
                <div className="space-y-6">
                  {TASK_CATEGORIES.map((cat) => {
                    const own = tasks.filter((t) => t.category === cat);
                    if (!own.length) return null;
                    return (
                      <div key={cat}>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{TASK_CATEGORY_LABELS[cat]}</h3>
                        <ul className="mt-1 divide-y divide-line">
                          {own.map((t) => (
                            <li key={t.id} className="flex flex-col gap-2 py-3">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-ink">{t.title}</p>
                                  {t.description ? <p className="text-xs text-ink-3">{t.description}</p> : null}
                                  <p className="text-xs text-ink-3">
                                    {t.required ? "Required" : "Optional"} · waiting on {t.waitingOn === "client" ? "the client" : "the Agency"}
                                    {t.ownerUserId ? ` · ${who(t.ownerUserId)}` : ""}
                                    {t.dueDate ? ` · due ${day(t.dueDate)}` : ""}
                                    {t.completedAt ? ` · done ${formatWhen(t.completedAt)} by ${who(t.completedBy)}` : ""}
                                  </p>
                                  {t.status === "blocked" ? <p className="break-words text-xs font-medium text-danger-text">Blocked: {t.blockedReason}</p> : null}
                                  {t.status === "wont_do" ? <p className="break-words text-xs text-ink-3">Won&rsquo;t do: {t.wontDoReason}</p> : null}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {isOverdue(t, today) ? <Badge tone="warning">Overdue</Badge> : null}
                                  <Badge tone={TASK_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                                </div>
                              </div>
                              <TaskControls clientId={client.id} task={t} admins={admins} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            ) : null}

            <SectionCard title="History" description="Every delivery change, newest first. Nothing here can be edited or deleted.">
              <EventList events={events} who={who} />
            </SectionCard>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <SectionCard title="Agreed terms" description="From the confirmed handoff. Read-only.">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-ink-3">Decision-maker</dt>
                <dd className="break-words text-ink">{client.contactName}</dd>
                <dt className="text-ink-3">Contact</dt>
                <dd className="break-words text-ink">{[client.contactEmail, client.contactPhone].filter(Boolean).join(" · ") || "—"}</dd>
                <dt className="text-ink-3">Setup fee</dt>
                <dd className="text-ink">{formatMoney(client.setupFee, client.currency)}</dd>
                <dt className="text-ink-3">Monthly fee</dt>
                <dd className="text-ink">{formatMoney(client.monthlyFee, client.currency)}/mo</dd>
              </dl>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-ink-2">{client.scope}</p>
            </SectionCard>

            {started ? (
              <SectionCard title="Service modules" action={<AddServicesForm client={client} />}>
                <ul className="flex flex-wrap gap-1.5">
                  {client.services.map((m) => (
                    <li key={m}>
                      <Badge tone="info">{SERVICE_MODULE_LABELS[m] ?? m}</Badge>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}

            {started ? (
              <SectionCard title="Owner and target date">
                <ClientDetailsForm client={client} admins={admins} />
              </SectionCard>
            ) : null}

            <SectionCard title="Trackpr account and live health">
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={health.tone}>{health.label}</Badge>
                  {live.signals.kind === "linked" ? <span className="text-ink-2">{live.signals.organizationName}</span> : null}
                </div>
                <p className="text-ink-2">{health.reason}</p>
                <p className="text-xs text-ink-3">Next step: {health.nextStep}</p>
                <p className="text-xs text-ink-3">Last verified healthy: Not recorded</p>
                {live.signals.kind === "linked" ? (
                  <>
                    <p className="text-xs text-ink-3">
                      Automation: {live.signals.paused == null ? "pause state couldn't be read" : live.signals.paused ? "paused" : "not paused"}
                      {" · "}
                      <Link href={`/agency/organizations/${live.signals.organizationId}`} className="font-medium text-ink underline">
                        Open the Trackpr account page
                      </Link>{" "}
                      to review or change it.
                    </p>
                    <div>
                      <p className="text-xs font-semibold text-ink-3">Open incidents</p>
                      {live.incidents == null ? (
                        <p className="text-xs text-ink-3">Incidents couldn&rsquo;t be read.</p>
                      ) : live.incidents.length === 0 ? (
                        <p className="text-xs text-ink-3">None open.</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {live.incidents.slice(0, 10).map((i) => (
                            <li key={i.id} className="break-words text-xs text-ink-2">
                              <span className="font-medium">{i.severity}</span> · {i.title} · last seen {formatWhen(i.lastSeenAt)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ) : null}
                {!client.organizationId ? (
                  linkable ? (
                    <LinkAccountForm client={client} organizations={linkable} />
                  ) : (
                    <p className="text-xs text-ink-3">Agency-managed accounts couldn&rsquo;t be read, so none can be linked right now.</p>
                  )
                ) : null}
              </div>
            </SectionCard>

            {launch ? (
              <SectionCard title="Launch record" description={`Approved ${formatWhen(launch.approvedAt)} by ${who(launch.approvedBy)}`}>
                <ReadinessList checks={launch.evidence.checks ?? []} />
                {launch.evidence.unverified_acknowledgement ? (
                  <p className="mt-3 break-words text-sm text-ink-2">
                    <span className="font-medium text-ink">Acknowledgement:</span> {launch.evidence.unverified_acknowledgement}
                  </p>
                ) : null}
              </SectionCard>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function stageDescription(status: keyof typeof LIFECYCLE_LABELS): string {
  switch (status) {
    case "onboarding_not_started":
      return "Choose the modules that were sold to generate the onboarding plan.";
    case "onboarding":
      return "Work through the tasks. When every required task is done and nothing is blocked, mark the client ready.";
    case "ready_to_launch":
      return "Review the readiness checks and approve the launch. Approval is recorded with the evidence.";
    case "live":
      return "Launched. Move to ongoing management once the client is settled.";
    default:
      return "Ongoing management.";
  }
}

function ReadinessList({ checks }: { checks: ReadinessCheck[] }) {
  if (!checks.length) return <p className="text-sm text-ink-3">No checks recorded.</p>;
  return (
    <ul className="divide-y divide-line" aria-label="Readiness checks">
      {checks.map((c) => (
        <li key={c.key} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {c.label}
              {c.critical ? <span className="ml-1 text-xs font-normal text-ink-3">(blocks launch if failed)</span> : null}
            </p>
            <p className="break-words text-xs text-ink-3">{c.detail}</p>
          </div>
          <Badge tone={CHECK_TONE[c.status]}>{CHECK_LABEL[c.status]}</Badge>
        </li>
      ))}
    </ul>
  );
}

function EventList({ events, who }: { events: DeliveryEvent[]; who: (id: string | null) => string }) {
  if (!events.length) return <p className="text-sm text-ink-3">Nothing recorded yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {events.map((e) => {
        const d = e.details as Record<string, unknown>;
        const extra = typeof d.title === "string" ? `${d.title}${typeof d.to === "string" ? ` → ${TASK_STATUS_LABELS[d.to as DeliveryTask["status"]] ?? d.to}` : ""}${typeof d.reason === "string" && d.reason ? ` (${d.reason})` : ""}` : Array.isArray(d.added) ? (d.added as string[]).join(", ") : Array.isArray(d.services) ? (d.services as string[]).join(", ") : "";
        return (
          <li key={e.id} className="py-2 text-sm">
            <p className="text-ink">
              {EVENT_LABELS[e.kind] ?? e.kind}
              {extra ? <span className="text-ink-2">: {extra}</span> : null}
            </p>
            <p className="text-xs text-ink-3">
              {formatWhen(e.occurredAt)} · {who(e.actorUserId)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
