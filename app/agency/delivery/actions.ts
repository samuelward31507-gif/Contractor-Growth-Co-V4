"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { getDeliveryClient, getLinkedSignals } from "@/lib/agency/delivery-queries";
import { TASK_STATUSES, isDateKey, launchBlockers, parseCustomTask, parseModules, readinessChecks, unverifiedChecks, type TaskStatus } from "@/lib/agency/delivery";

/**
 * Agency client delivery writes. Every action re-checks that the caller is
 * an agency admin with their own session before anything else, then calls
 * the database function with that same session - the function checks the
 * admin, the row lock, the expected version and the launch gate again for
 * itself. No service-role client writes anything: it is used only by
 * approveLaunch to READ the linked account's signals for the readiness
 * evidence, after the admin check, exactly as the client page does.
 *
 * Nothing here sends a message, changes Trackpr Go Live, unpauses
 * automation, or adds an organization to agency_organizations.
 */

export type DeliveryActionResult = { ok: true; status: "recorded" | "duplicate" } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOT_AUTHORIZED: DeliveryActionResult = { ok: false, error: "Not authorized." };
const NOT_FOUND: DeliveryActionResult = { ok: false, error: "That client or task could not be found." };
const isUuid = (v: unknown): v is string => UUID.test(String(v ?? ""));
const isVersion = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64 && !Number.isNaN(Date.parse(v));
const optionalUuid = (v: unknown): string | null | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return isUuid(s) ? s : undefined;
};
const optionalDate = (v: unknown): string | null | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return isDateKey(s) ? s : undefined;
};

function message(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "FS404":
      return "That client or task could not be found.";
    case "FS409":
    case "FS422": {
      const text = (error.message ?? "").trim();
      const sentence = text ? `${text[0].toUpperCase()}${text.slice(1)}` : "That isn't possible right now";
      return error.code === "FS409" ? `${sentence}. Refresh to see the latest.` : `${sentence}.`;
    }
    case "23505":
      return "Someone else just made the same change. Refresh to see the latest.";
    case "42883":
    case "PGRST202":
      return "Client delivery isn't enabled on this database yet.";
    default:
      return "We couldn't save that. Please try again - a retry never records it twice.";
  }
}

async function adminSession() {
  const supabase = await createClient();
  return (await isAgencyAdmin(supabase)) ? supabase : null;
}

async function call(clientId: string, fn: string, args: Record<string, unknown>): Promise<DeliveryActionResult> {
  const supabase = await adminSession();
  if (!supabase) return NOT_AUTHORIZED;
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: message(error) };
  revalidatePath("/agency/delivery");
  revalidatePath(`/agency/delivery/${clientId}`);
  revalidatePath("/agency/handoffs");
  return { ok: true, status: (data as { status?: string } | null)?.status === "duplicate" ? "duplicate" : "recorded" };
}

/** Starts onboarding: records the sold modules and generates the core + module task list. */
export async function startOnboarding(clientId: string, input: { expectedUpdatedAt: unknown; services: unknown; ownerUserId?: unknown; targetLaunchDate?: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const services = parseModules(input.services);
  if (!services) return { ok: false, error: "Choose only the listed service modules." };
  if (!services.length) return { ok: false, error: "Choose at least one service module that was sold." };
  const owner = optionalUuid(input.ownerUserId);
  if (owner === undefined) return { ok: false, error: "Choose a valid owner." };
  const target = optionalDate(input.targetLaunchDate);
  if (target === undefined) return { ok: false, error: "Enter a valid target launch date." };
  return call(clientId, "agency_start_onboarding", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt, p_services: services, p_owner_user_id: owner, p_target_launch_date: target });
}

/** Adds modules sold later; only adds tasks, never removes any. */
export async function addServices(clientId: string, input: { expectedUpdatedAt: unknown; services: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const services = parseModules(input.services);
  if (!services) return { ok: false, error: "Choose only the listed service modules." };
  if (!services.length) return { ok: false, error: "Choose a module to add." };
  return call(clientId, "agency_add_services", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt, p_services: services });
}

/** Adds a custom task. The request id makes a double submit add it once. */
export async function addTask(clientId: string, input: Record<string, unknown> & { requestId: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isUuid(input.requestId)) return { ok: false, error: "Refresh the page and try again." };
  const parsed = parseCustomTask(input);
  if (!parsed.ok) return parsed;
  const owner = optionalUuid(input.ownerUserId);
  if (owner === undefined) return { ok: false, error: "Choose a valid owner." };
  const t = parsed.value;
  return call(clientId, "agency_add_task", {
    p_request_id: input.requestId,
    p_client_id: clientId,
    p_title: t.title,
    p_description: t.description,
    p_category: t.category,
    p_required: t.required,
    p_waiting_on: t.waitingOn,
    p_owner_user_id: owner,
    p_due_date: t.dueDate,
  });
}

export async function setTaskStatus(clientId: string, taskId: string, input: { expectedUpdatedAt: unknown; status: unknown; reason?: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId) || !isUuid(taskId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const status = String(input.status ?? "");
  if (!(TASK_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Choose a valid status." };
  const reason = String(input.reason ?? "").trim();
  if ((status === "blocked" || status === "wont_do") && (!reason || reason.length > 500)) return { ok: false, error: "Say why (up to 500 characters)." };
  return call(clientId, "agency_set_task_status", { p_task_id: taskId, p_expected_updated_at: input.expectedUpdatedAt, p_status: status as TaskStatus, p_reason: reason || null });
}

export async function setTaskDetails(clientId: string, taskId: string, input: { expectedUpdatedAt: unknown; ownerUserId?: unknown; dueDate?: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId) || !isUuid(taskId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const owner = optionalUuid(input.ownerUserId);
  if (owner === undefined) return { ok: false, error: "Choose a valid owner." };
  const due = optionalDate(input.dueDate);
  if (due === undefined) return { ok: false, error: "Enter a valid due date." };
  return call(clientId, "agency_set_task_details", { p_task_id: taskId, p_expected_updated_at: input.expectedUpdatedAt, p_owner_user_id: owner, p_due_date: due });
}

export async function setClientDetails(clientId: string, input: { expectedUpdatedAt: unknown; ownerUserId?: unknown; targetLaunchDate?: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const owner = optionalUuid(input.ownerUserId);
  if (owner === undefined) return { ok: false, error: "Choose a valid owner." };
  const target = optionalDate(input.targetLaunchDate);
  if (target === undefined) return { ok: false, error: "Enter a valid target launch date." };
  return call(clientId, "agency_set_client_details", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt, p_owner_user_id: owner, p_target_launch_date: target });
}

export async function markReadyToLaunch(clientId: string, input: { expectedUpdatedAt: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  return call(clientId, "agency_mark_ready_to_launch", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt });
}

export async function moveToOngoing(clientId: string, input: { expectedUpdatedAt: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  return call(clientId, "agency_move_to_ongoing", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt });
}

/** Links an already Agency-managed Trackpr account. Never adds to agency_organizations - the database refuses any other account. */
export async function linkOrganization(clientId: string, input: { expectedUpdatedAt: unknown; organizationId: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  if (!isUuid(input.organizationId)) return { ok: false, error: "Choose an Agency-managed Trackpr account." };
  return call(clientId, "agency_link_client_organization", { p_client_id: clientId, p_expected_updated_at: input.expectedUpdatedAt, p_organization_id: input.organizationId });
}

/**
 * Approves launch. The readiness evidence is computed HERE from fresh reads -
 * the browser supplies only the written acknowledgement of unverified checks
 * and the request id (so a retry or double click records one launch). The
 * database re-checks the task gate and refuses critical failures again.
 * Approving changes only the Agency client's lifecycle: it doesn't go live in
 * Trackpr, unpause anything, or send anything.
 */
export async function approveLaunch(clientId: string, input: { requestId: unknown; expectedUpdatedAt: unknown; acknowledgement?: unknown }): Promise<DeliveryActionResult> {
  if (!isUuid(clientId)) return NOT_FOUND;
  if (!isUuid(input.requestId) || !isVersion(input.expectedUpdatedAt)) return { ok: false, error: "Refresh the page and try again." };
  const acknowledgement = String(input.acknowledgement ?? "").trim();
  if (acknowledgement.length > 1000) return { ok: false, error: "Keep the acknowledgement under 1,000 characters." };

  const supabase = await adminSession();
  if (!supabase) return NOT_AUTHORIZED;
  const loaded = await getDeliveryClient(supabase, clientId);
  if (!loaded.ok) return loaded.reason === "not_found" ? NOT_FOUND : loaded.reason === "not_agency_admin" ? NOT_AUTHORIZED : { ok: false, error: "We couldn't read the client to check readiness. Please try again." };
  if (!loaded.available) return { ok: false, error: "Client delivery isn't enabled on this database yet." };
  const { client, tasks, launch } = loaded.detail;
  if (launch) return { ok: true, status: "duplicate" };

  const { signals } = await getLinkedSignals(createServiceRoleClient(), client.organizationId);
  const checks = readinessChecks(client, tasks, signals);
  const blockers = launchBlockers(checks);
  if (blockers.length) return { ok: false, error: `Can't launch yet: ${blockers.map((c) => `${c.label} (${c.detail})`).join("; ")}.` };
  if (unverifiedChecks(checks).length && acknowledgement.length < 10) return { ok: false, error: "Acknowledge the unverified checks in writing before launching." };

  return call(clientId, "agency_approve_launch", {
    p_request_id: input.requestId,
    p_client_id: clientId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_evidence: { checks, unverified_acknowledgement: acknowledgement || null },
  });
}
