import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { listIncidents } from "@/lib/automation-health/queries";
import type { AutomationIncident } from "@/lib/automation-health/types";
import { computeSetupChecklist } from "@/lib/onboarding/checklist";
import { isAgencyAdmin } from "./queries";
import type { DeliveryClient, DeliveryEvent, DeliveryLaunch, DeliveryTask, LifecycleStatus, LinkedSignals, ServiceModule, TaskCategory, TaskStatus } from "./delivery";

/**
 * Agency client delivery reads (supabase/pending/agency_client_delivery.sql).
 *
 * Clients, tasks, events and launches are read with the caller's own session
 * client - RLS lets only agency admins see them, and the admin check runs
 * first so a non-admin gets "unauthorized", never an empty list.
 *
 * Live signals for a linked Trackpr account follow the Agency's existing
 * "authenticate first, service-role second" shape: only after the caller is
 * confirmed an agency admin AND the linked organization is confirmed to be
 * in agency_organizations is anything read for it, and only reads - health,
 * incidents, setup checklist, payment status, pause state. Nothing here
 * writes, and every read that fails reads as unavailable, never as healthy.
 */

export const MAX_CLIENT_ROWS = 500;
export const MAX_TASK_ROWS = 5000;
export const MAX_EVENT_ROWS = 200;

type ClientRow = {
  id: string;
  name: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  setup_fee: number | string;
  monthly_fee: number | string;
  currency: string;
  scope: string;
  status: LifecycleStatus;
  status_changed_at: string;
  owner_user_id: string | null;
  target_launch_date: string | null;
  services: string[] | null;
  onboarding_started_at: string | null;
  launched_at: string | null;
  launched_by: string | null;
  organization_id: string | null;
  organization_linked_at: string | null;
  created_at: string;
  updated_at: string;
};
export const DELIVERY_CLIENT_COLUMNS =
  "id, name, contact_name, contact_email, contact_phone, setup_fee, monthly_fee, currency, scope, status, status_changed_at, owner_user_id, target_launch_date, services, onboarding_started_at, launched_at, launched_by, organization_id, organization_linked_at, created_at, updated_at";
export const toDeliveryClient = (r: ClientRow): DeliveryClient => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  setupFee: Number(r.setup_fee),
  monthlyFee: Number(r.monthly_fee),
  currency: r.currency,
  scope: r.scope,
  status: r.status,
  statusChangedAt: r.status_changed_at,
  ownerUserId: r.owner_user_id,
  targetLaunchDate: r.target_launch_date,
  services: (r.services ?? []) as ServiceModule[],
  onboardingStartedAt: r.onboarding_started_at,
  launchedAt: r.launched_at,
  launchedBy: r.launched_by,
  organizationId: r.organization_id,
  organizationLinkedAt: r.organization_linked_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

type TaskRow = {
  id: string;
  client_id: string;
  template_key: string | null;
  module: string | null;
  category: TaskCategory;
  title: string;
  description: string | null;
  required: boolean;
  waiting_on: "agency" | "client";
  status: TaskStatus;
  blocked_reason: string | null;
  wont_do_reason: string | null;
  owner_user_id: string | null;
  due_date: string | null;
  sort_order: number;
  completed_at: string | null;
  completed_by: string | null;
  updated_at: string;
};
export const DELIVERY_TASK_COLUMNS =
  "id, client_id, template_key, module, category, title, description, required, waiting_on, status, blocked_reason, wont_do_reason, owner_user_id, due_date, sort_order, completed_at, completed_by, updated_at";
export const toDeliveryTask = (r: TaskRow): DeliveryTask => ({
  id: r.id,
  clientId: r.client_id,
  templateKey: r.template_key,
  module: r.module,
  category: r.category,
  title: r.title,
  description: r.description,
  required: r.required,
  waitingOn: r.waiting_on,
  status: r.status,
  blockedReason: r.blocked_reason,
  wontDoReason: r.wont_do_reason,
  ownerUserId: r.owner_user_id,
  dueDate: r.due_date,
  sortOrder: r.sort_order,
  completedAt: r.completed_at,
  completedBy: r.completed_by,
  updatedAt: r.updated_at,
});

type EventRow = { id: string; client_id: string; task_id: string | null; kind: string; actor_user_id: string | null; occurred_at: string; details: Record<string, unknown> | null };
type LaunchRow = { id: string; client_id: string; approved_by: string; approved_at: string; evidence: DeliveryLaunch["evidence"] | null };

/** The delivery tables / columns aren't on this database yet. */
export function isMissingDeliverySchema(error: { code?: string; message?: string }): boolean {
  const msg = error.message ?? "";
  return error.code === "42P01" || error.code === "PGRST205" || error.code === "42703" || (/agency_client/.test(msg) && /does not exist|could not find/i.test(msg));
}

export type AdminDirectoryEntry = { userId: string; email: string };

export type DeliveryOverviewResult =
  | { ok: true; available: boolean; clients: DeliveryClient[]; tasks: DeliveryTask[] }
  | { ok: false; reason: "not_agency_admin" | "load_failed" };

export async function getDeliveryOverview(sessionSupabase: SupabaseClient): Promise<DeliveryOverviewResult> {
  if (!(await isAgencyAdmin(sessionSupabase))) return { ok: false, reason: "not_agency_admin" };
  const [clients, tasks] = await Promise.all([
    sessionSupabase.from("agency_clients").select(DELIVERY_CLIENT_COLUMNS).order("created_at", { ascending: false }).limit(MAX_CLIENT_ROWS),
    sessionSupabase.from("agency_client_tasks").select(DELIVERY_TASK_COLUMNS).order("sort_order", { ascending: true }).limit(MAX_TASK_ROWS),
  ]);
  if ([clients.error, tasks.error].some((e) => e && isMissingDeliverySchema(e))) return { ok: true, available: false, clients: [], tasks: [] };
  if (clients.error || tasks.error) return { ok: false, reason: "load_failed" };
  return { ok: true, available: true, clients: (clients.data as ClientRow[]).map(toDeliveryClient), tasks: (tasks.data as TaskRow[]).map(toDeliveryTask) };
}

export type DeliveryClientDetail = {
  client: DeliveryClient;
  tasks: DeliveryTask[];
  events: DeliveryEvent[];
  launch: DeliveryLaunch | null;
  admins: AdminDirectoryEntry[];
};

export type DeliveryClientResult =
  | { ok: true; available: true; detail: DeliveryClientDetail }
  | { ok: true; available: false }
  | { ok: false; reason: "not_agency_admin" | "not_found" | "load_failed" };

/** One client with its tasks, history and launch record - session client only. */
export async function getDeliveryClient(sessionSupabase: SupabaseClient, clientId: string): Promise<DeliveryClientResult> {
  if (!(await isAgencyAdmin(sessionSupabase))) return { ok: false, reason: "not_agency_admin" };
  const [client, tasks, events, launch, admins] = await Promise.all([
    sessionSupabase.from("agency_clients").select(DELIVERY_CLIENT_COLUMNS).eq("id", clientId).maybeSingle(),
    sessionSupabase.from("agency_client_tasks").select(DELIVERY_TASK_COLUMNS).eq("client_id", clientId).order("sort_order", { ascending: true }).order("created_at", { ascending: true }).limit(MAX_TASK_ROWS),
    sessionSupabase.from("agency_client_events").select("id, client_id, task_id, kind, actor_user_id, occurred_at, details").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(MAX_EVENT_ROWS),
    sessionSupabase.from("agency_client_launches").select("id, client_id, approved_by, approved_at, evidence").eq("client_id", clientId).maybeSingle(),
    sessionSupabase.rpc("agency_admin_directory"),
  ]);
  if ([client.error, tasks.error, events.error, launch.error].some((e) => e && isMissingDeliverySchema(e))) return { ok: true, available: false };
  if (client.error || tasks.error || events.error || launch.error) return { ok: false, reason: "load_failed" };
  if (!client.data) return { ok: false, reason: "not_found" };
  const l = launch.data as LaunchRow | null;
  return {
    ok: true,
    available: true,
    detail: {
      client: toDeliveryClient(client.data as ClientRow),
      tasks: (tasks.data as TaskRow[]).map(toDeliveryTask),
      events: (events.data as EventRow[]).map((e) => ({ id: e.id, clientId: e.client_id, taskId: e.task_id, kind: e.kind, actorUserId: e.actor_user_id, occurredAt: e.occurred_at, details: e.details ?? {} })),
      launch: l ? { id: l.id, clientId: l.client_id, approvedBy: l.approved_by, approvedAt: l.approved_at, evidence: l.evidence ?? {} } : null,
      // The directory only resolves ids to emails; if it can't be read the page shows ids instead.
      admins: admins.error ? [] : ((admins.data ?? []) as { user_id: string; email: string }[]).map((a) => ({ userId: a.user_id, email: a.email })),
    },
  };
}

export type LiveSignalsResult = { signals: LinkedSignals; incidents: AutomationIncident[] | null };

/**
 * What the linked Trackpr account says right now. Call only after the caller
 * is confirmed an agency admin (getDeliveryClient does that). The service
 * client is used for reads only, and only for an organization confirmed to
 * be in agency_organizations here.
 */
export async function getLinkedSignals(service: SupabaseClient, organizationId: string | null): Promise<LiveSignalsResult> {
  if (!organizationId) return { signals: { kind: "not_linked" }, incidents: null };
  const managed = await service.from("agency_organizations").select("organization_id, organizations(name)").eq("organization_id", organizationId).maybeSingle();
  if (managed.error) return { signals: { kind: "unavailable", organizationId }, incidents: null };
  if (!managed.data) return { signals: { kind: "not_managed", organizationId }, incidents: null };
  const embedded = (managed.data as { organizations?: { name?: string | null } | { name?: string | null }[] | null }).organizations;
  const organizationName = (Array.isArray(embedded) ? embedded[0]?.name : embedded?.name) ?? "Unnamed Trackpr account";

  const settle = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch {
      return null;
    }
  };
  const [health, checklist, incidents, org] = await Promise.all([
    settle(getOrganizationHealth(service, organizationId)),
    settle(computeSetupChecklist(service, organizationId)),
    settle(listIncidents(service, organizationId, { status: ["open", "acknowledged"] })),
    settle(Promise.resolve(service.from("organizations").select("payment_status, automation_paused").eq("id", organizationId).maybeSingle())),
  ]);
  const orgRow = org && !org.error ? (org.data as { payment_status: string | null; automation_paused: boolean | null } | null) : null;
  return {
    signals: {
      kind: "linked",
      organizationId,
      organizationName,
      health,
      checklist,
      paymentStatus: orgRow?.payment_status ?? null,
      paused: orgRow ? Boolean(orgRow.automation_paused) : null,
    },
    // listIncidents returns [] on a failed read, so an empty list only counts as "none" when health could read incidents.
    incidents: incidents && !(health?.incidentsUnavailable ?? true) ? incidents : null,
  };
}

/** Agency-managed Trackpr accounts not yet linked to any Agency client - the only ones a client can be linked to. */
export async function getLinkableOrganizations(sessionSupabase: SupabaseClient, service: SupabaseClient): Promise<{ ok: true; organizations: { organizationId: string; organizationName: string }[] } | { ok: false }> {
  const [managed, linked] = await Promise.all([
    service.from("agency_organizations").select("organization_id, organizations(name)").order("created_at", { ascending: true }).limit(MAX_CLIENT_ROWS),
    sessionSupabase.from("agency_clients").select("organization_id").not("organization_id", "is", null).limit(MAX_CLIENT_ROWS),
  ]);
  if (managed.error || linked.error) return { ok: false };
  const taken = new Set((linked.data as { organization_id: string }[]).map((r) => r.organization_id));
  return {
    ok: true,
    organizations: (managed.data as { organization_id: string; organizations?: { name?: string | null } | { name?: string | null }[] | null }[])
      .filter((r) => !taken.has(r.organization_id))
      .map((r) => {
        const o = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
        return { organizationId: r.organization_id, organizationName: o?.name ?? "Unnamed Trackpr account" };
      }),
  };
}
