/**
 * Agency client delivery - the pure part: lifecycle, modules, task gate,
 * readiness checks (Passed / Failed / Unverified), live-health display and
 * next actions. No I/O (lib/agency/delivery-queries.ts reads, the
 * app/agency/delivery actions write through the database functions in
 * supabase/pending/agency_client_delivery.sql, which enforce the same gate
 * again).
 *
 * Honest by construction: a check that this system can't read is
 * "unverified", never "passed"; a health read that failed is "unavailable",
 * never "healthy"; nothing here records a "last verified healthy" time
 * because nothing measures one.
 */
import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { SetupChecklist } from "@/lib/onboarding/checklist";

export const LIFECYCLE = ["onboarding_not_started", "onboarding", "ready_to_launch", "live", "ongoing_management"] as const;
export type LifecycleStatus = (typeof LIFECYCLE)[number];
export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  onboarding_not_started: "Onboarding not started",
  onboarding: "Onboarding",
  ready_to_launch: "Ready to launch",
  live: "Live",
  ongoing_management: "Ongoing management",
};

export const SERVICE_MODULES = ["lead_response", "sms", "follow_up", "booking", "crm", "reporting", "online_payments"] as const;
export type ServiceModule = (typeof SERVICE_MODULES)[number];
export const SERVICE_MODULE_LABELS: Record<ServiceModule, string> = {
  lead_response: "Lead response",
  sms: "Texting / SMS",
  follow_up: "Follow-up sequences",
  booking: "Booking & calendar",
  crm: "Pipeline / CRM",
  reporting: "Reporting",
  online_payments: "Online payments",
};

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "wont_do"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done", wont_do: "Won't do" };

export const TASK_CATEGORIES = ["access", "client_info", "lead_intake", "messaging", "follow_up", "crm", "integrations", "reporting", "testing", "training", "other"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  access: "Access & accounts",
  client_info: "Client information",
  lead_intake: "Lead intake",
  messaging: "Messaging",
  follow_up: "Follow-up",
  crm: "Pipeline / CRM",
  integrations: "Integrations",
  reporting: "Reporting",
  testing: "Testing & acceptance",
  training: "Training",
  other: "Other",
};

export type DeliveryClient = {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  setupFee: number;
  monthlyFee: number;
  currency: string;
  scope: string;
  status: LifecycleStatus;
  statusChangedAt: string;
  ownerUserId: string | null;
  targetLaunchDate: string | null;
  services: ServiceModule[];
  onboardingStartedAt: string | null;
  launchedAt: string | null;
  launchedBy: string | null;
  organizationId: string | null;
  organizationLinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryTask = {
  id: string;
  clientId: string;
  templateKey: string | null;
  module: string | null;
  category: TaskCategory;
  title: string;
  description: string | null;
  required: boolean;
  waitingOn: "agency" | "client";
  status: TaskStatus;
  blockedReason: string | null;
  wontDoReason: string | null;
  ownerUserId: string | null;
  dueDate: string | null;
  sortOrder: number;
  completedAt: string | null;
  completedBy: string | null;
  updatedAt: string;
};

export type DeliveryEvent = { id: string; clientId: string; taskId: string | null; kind: string; actorUserId: string | null; occurredAt: string; details: Record<string, unknown> };
export type ReadinessCheckStatus = "passed" | "failed" | "unverified";
export type ReadinessCheck = { key: string; label: string; status: ReadinessCheckStatus; critical: boolean; detail: string };
export type DeliveryLaunch = { id: string; clientId: string; approvedBy: string; approvedAt: string; evidence: { checks?: ReadinessCheck[]; unverified_acknowledgement?: string | null } };

/** What the linked Trackpr account says - read from the existing health / incident / setup / payment data. */
export type LinkedSignals =
  | { kind: "not_linked" }
  /** Linked, but the account is no longer in agency_organizations - nothing is read for it. */
  | { kind: "not_managed"; organizationId: string }
  /** Linked, but whether it is still Agency-managed couldn't be read - nothing is read for it. */
  | { kind: "unavailable"; organizationId: string }
  | {
      kind: "linked";
      organizationId: string;
      organizationName: string;
      health: OrganizationHealthSummary | null;
      checklist: SetupChecklist | null;
      paymentStatus: string | null;
      paused: boolean | null;
    };

const isOpen = (t: DeliveryTask) => t.status !== "done" && t.status !== "wont_do";

/** YYYY-MM-DD before today (local key) on an open task. */
export function isOverdue(task: Pick<DeliveryTask, "dueDate" | "status">, todayKey: string): boolean {
  return task.dueDate != null && task.dueDate < todayKey && task.status !== "done" && task.status !== "wont_do";
}

/** The launch gate as the database computes it: every required task done, nothing blocked. */
export function taskGate(tasks: DeliveryTask[]) {
  const required = tasks.filter((t) => t.required);
  const blocked = tasks.filter((t) => t.status === "blocked");
  return {
    total: tasks.length,
    requiredTotal: required.length,
    requiredDone: required.filter((t) => t.status === "done").length,
    blocked,
    clientInputsOpen: tasks.filter((t) => t.waitingOn === "client" && isOpen(t)),
    passes: tasks.length > 0 && required.every((t) => t.status === "done") && blocked.length === 0,
  };
}

const UNLINKED = "Unverified - no Trackpr account linked";

/**
 * Readiness, one check per thing that matters before launch. Task checks come
 * from the tasks; account checks come only from the linked, Agency-managed
 * Trackpr account - without one they are Unverified, never Passed.
 * `critical` failures block launch (the database refuses them too).
 */
export function readinessChecks(client: Pick<DeliveryClient, "services">, tasks: DeliveryTask[], signals: LinkedSignals): ReadinessCheck[] {
  const gate = taskGate(tasks);
  const done = (key: string) => tasks.find((t) => t.templateKey === key)?.status === "done";
  const checks: ReadinessCheck[] = [
    {
      key: "required_tasks",
      label: "Required onboarding tasks",
      status: gate.requiredTotal > 0 && gate.requiredDone === gate.requiredTotal ? "passed" : "failed",
      critical: true,
      detail: `${gate.requiredDone} of ${gate.requiredTotal} done`,
    },
    { key: "blockers", label: "No blocked tasks", status: gate.blocked.length === 0 ? "passed" : "failed", critical: true, detail: gate.blocked.length ? gate.blocked.map((t) => `${t.title}: ${t.blockedReason}`).join("; ") : "None blocked" },
    {
      key: "client_inputs",
      label: "Client inputs received",
      status: gate.clientInputsOpen.length === 0 ? "passed" : "failed",
      critical: gate.clientInputsOpen.some((t) => t.required),
      detail: gate.clientInputsOpen.length ? `Waiting on the client: ${gate.clientInputsOpen.map((t) => t.title).join("; ")}` : "Nothing waiting on the client",
    },
    {
      key: "testing",
      label: "End-to-end test and client acceptance",
      status: done("core.end_to_end_test") && done("core.client_acceptance") ? "passed" : "failed",
      critical: true,
      detail: done("core.end_to_end_test") && done("core.client_acceptance") ? "Both recorded as done" : "Not both recorded as done",
    },
  ];

  if (signals.kind !== "linked") {
    const detail =
      signals.kind === "not_linked" ? UNLINKED : signals.kind === "not_managed" ? "Unverified - the linked Trackpr account isn't Agency-managed any more" : "Unverified - the linked Trackpr account couldn't be read";
    checks.push({ key: "trackpr_account", label: "Trackpr account linked", status: "unverified", critical: false, detail });
    checks.push({ key: "payment_status", label: "Client's Trackpr payment status", status: "unverified", critical: false, detail });
    checks.push({ key: "automation_health", label: "Automation health", status: "unverified", critical: false, detail });
    for (const m of client.services) if (MODULE_CHECK_LABEL[m]) checks.push({ key: `module_${m}`, label: MODULE_CHECK_LABEL[m] as string, status: "unverified", critical: false, detail });
    return checks;
  }

  checks.push({ key: "trackpr_account", label: "Trackpr account linked", status: "passed", critical: false, detail: signals.organizationName });
  checks.push(
    signals.paymentStatus == null
      ? { key: "payment_status", label: "Client's Trackpr payment status", status: "unverified", critical: false, detail: "Couldn't be read" }
      : { key: "payment_status", label: "Client's Trackpr payment status", status: signals.paymentStatus === "active" ? "passed" : "failed", critical: true, detail: `Payment status: ${signals.paymentStatus.replace(/_/g, " ")}` },
  );
  const health = signals.health;
  if (!health || health.incidentsUnavailable) {
    checks.push({ key: "automation_health", label: "Automation health", status: "unverified", critical: false, detail: "Health couldn't be read" });
  } else {
    checks.push({
      key: "automation_health",
      label: "Automation health",
      status: health.status === "healthy" ? "passed" : "failed",
      critical: health.status === "unhealthy",
      detail: describeHealth(health).reason,
    });
  }
  const item = (key: string) => signals.checklist?.items.find((i) => i.key === key) ?? null;
  const fromItem = (key: string, checkKey: string, label: string, note: string): ReadinessCheck => {
    const it = item(key);
    if (!signals.checklist || !it) return { key: checkKey, label, status: "unverified", critical: false, detail: "Setup checklist couldn't be read" };
    return { key: checkKey, label, status: it.state === "ready" || it.complete ? "passed" : "failed", critical: false, detail: note };
  };
  checks.push(fromItem("testVerified", "test_lead_verified", "Test lead verified in Trackpr", "From the account's own test-lead record"));
  if (client.services.includes("sms")) checks.push(fromItem("sms", "module_sms", MODULE_CHECK_LABEL.sms as string, "A number is configured - carrier registration isn't checked here"));
  if (client.services.includes("lead_response")) checks.push(fromItem("leadCapture", "module_lead_response", MODULE_CHECK_LABEL.lead_response as string, "An intake link exists - whether leads arrive isn't checked here"));
  if (client.services.includes("booking")) checks.push(fromItem("calendar", "module_booking", MODULE_CHECK_LABEL.booking as string, "From the calendar connection's recorded state"));
  if (client.services.includes("online_payments")) checks.push({ key: "module_online_payments", label: MODULE_CHECK_LABEL.online_payments as string, status: "unverified", critical: false, detail: "Stripe Connect status isn't read by the Agency view" });
  return checks;
}

const MODULE_CHECK_LABEL: Partial<Record<ServiceModule, string>> = {
  sms: "Texting number configured",
  lead_response: "Lead intake link configured",
  booking: "Calendar connected",
  online_payments: "Online payments enabled",
};

export function launchBlockers(checks: ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((c) => c.status === "failed" && c.critical);
}
export const unverifiedChecks = (checks: ReadinessCheck[]) => checks.filter((c) => c.status === "unverified");

export type HealthDisplay = { tone: "success" | "warning" | "danger" | "neutral"; label: string; reason: string; nextStep: string };

/** The known reason, in words - from organizationStatus' own precedence, never re-derived. */
export function describeHealth(h: OrganizationHealthSummary): HealthDisplay {
  switch (h.status) {
    case "payment_blocked":
      return { tone: "danger", label: "Payment blocked", reason: `Trackpr payment status is ${h.paymentStatus.replace(/_/g, " ")}, so automation is held.`, nextStep: "Check the client's billing status with them; nothing here changes it." };
    case "paused":
      return { tone: "warning", label: "Paused", reason: "Automation is paused by an agency admin.", nextStep: "Review on the client's Trackpr page before resuming - resuming is a manual decision." };
    case "unhealthy":
      return { tone: "danger", label: "Unhealthy", reason: `${h.criticalIncidentCount} critical incident${h.criticalIncidentCount === 1 ? "" : "s"} open.`, nextStep: "Open the incidents on the client's Trackpr page and resolve the critical ones first." };
    case "degraded":
      return {
        tone: "warning",
        label: "Degraded",
        reason: [h.activeIncidentCount ? `${h.activeIncidentCount} open incident${h.activeIncidentCount === 1 ? "" : "s"}` : null, h.staleScheduledAutomationCount ? `${h.staleScheduledAutomationCount} scheduled automation${h.staleScheduledAutomationCount === 1 ? "" : "s"} gone quiet` : null].filter(Boolean).join("; ") || "Open incidents",
        nextStep: "Review the open incidents on the client's Trackpr page.",
      };
    default:
      return { tone: "success", label: "Healthy", reason: "No open incidents and nothing paused or blocked at the time of this read.", nextStep: "Nothing needed." };
  }
}

/** Health for the client page: not linked / not managed / unavailable are said plainly - never shown as healthy. */
export function liveHealth(signals: LinkedSignals): HealthDisplay {
  if (signals.kind === "not_linked") return { tone: "neutral", label: "Unverified", reason: "No Trackpr account linked.", nextStep: "Link the client's Agency-managed Trackpr account." };
  if (signals.kind === "not_managed") return { tone: "neutral", label: "Unverified", reason: "The linked Trackpr account isn't Agency-managed any more.", nextStep: "Check the account's Agency access." };
  if (signals.kind === "unavailable" || !signals.health || signals.health.incidentsUnavailable) return { tone: "neutral", label: "Unavailable", reason: "Health couldn't be read just now.", nextStep: "Refresh, or open the client's Trackpr page." };
  return describeHealth(signals.health);
}

export type NextAction = { clientId: string; clientName: string; kind: "blocked" | "overdue" | "ready" | "client_input" | "not_started" | "readiness"; label: string; detail: string };

const ACTION_RANK: Record<NextAction["kind"], number> = { blocked: 0, overdue: 1, ready: 2, readiness: 3, client_input: 4, not_started: 5 };

/**
 * The few things worth doing next across clients, from recorded tasks and
 * lifecycle only (live health is per client page, read on demand).
 */
export function nextActions(clients: DeliveryClient[], tasks: DeliveryTask[], todayKey: string, limit = 8): NextAction[] {
  const byClient = new Map<string, DeliveryTask[]>();
  for (const t of tasks) byClient.set(t.clientId, [...(byClient.get(t.clientId) ?? []), t]);
  const out: NextAction[] = [];
  for (const c of clients) {
    const own = byClient.get(c.id) ?? [];
    if (c.status === "onboarding_not_started") {
      out.push({ clientId: c.id, clientName: c.name, kind: "not_started", label: "Start onboarding", detail: "Confirmed, but no onboarding plan yet" });
      continue;
    }
    for (const t of own.filter((x) => x.status === "blocked")) out.push({ clientId: c.id, clientName: c.name, kind: "blocked", label: `Unblock: ${t.title}`, detail: t.blockedReason ?? "Blocked" });
    for (const t of own.filter((x) => isOverdue(x, todayKey) && x.status !== "blocked")) out.push({ clientId: c.id, clientName: c.name, kind: "overdue", label: `Overdue: ${t.title}`, detail: `Due ${t.dueDate}` });
    if (c.status === "ready_to_launch") out.push({ clientId: c.id, clientName: c.name, kind: "ready", label: "Review and approve launch", detail: "All required tasks done" });
    if (c.status === "onboarding" && taskGate(own).passes) out.push({ clientId: c.id, clientName: c.name, kind: "readiness", label: "Mark ready to launch", detail: "Every required task is done" });
    const inputs = own.filter((x) => x.waitingOn === "client" && x.status !== "done" && x.status !== "wont_do" && x.status !== "blocked");
    if (inputs.length && (c.status === "onboarding" || c.status === "ready_to_launch")) out.push({ clientId: c.id, clientName: c.name, kind: "client_input", label: `${inputs.length} client input${inputs.length === 1 ? "" : "s"} outstanding`, detail: inputs.map((x) => x.title).slice(0, 2).join("; ") });
  }
  return out.sort((a, b) => ACTION_RANK[a.kind] - ACTION_RANK[b.kind] || a.clientName.localeCompare(b.clientName) || a.label.localeCompare(b.label)).slice(0, limit);
}

/** Validation for a custom task (the database checks again). */
export function parseCustomTask(raw: Record<string, unknown>): { ok: true; value: { title: string; description: string | null; category: TaskCategory; required: boolean; waitingOn: "agency" | "client"; dueDate: string | null } } | { ok: false; error: string } {
  const title = String(raw.title ?? "").trim();
  if (!title || title.length > 200) return { ok: false, error: "Give the task a title (up to 200 characters)." };
  const description = String(raw.description ?? "").trim();
  if (description.length > 2000) return { ok: false, error: "Keep the description under 2,000 characters." };
  const category = String(raw.category ?? "other");
  if (!(TASK_CATEGORIES as readonly string[]).includes(category)) return { ok: false, error: "Choose a valid category." };
  const waitingOn = String(raw.waitingOn ?? "agency");
  if (waitingOn !== "agency" && waitingOn !== "client") return { ok: false, error: "Choose who the task is waiting on." };
  const dueDate = String(raw.dueDate ?? "").trim() || null;
  if (dueDate && !isDateKey(dueDate)) return { ok: false, error: "Enter a valid due date." };
  return { ok: true, value: { title, description: description || null, category: category as TaskCategory, required: raw.required === true || raw.required === "on" || raw.required === "true", waitingOn, dueDate } };
}

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseModules(raw: unknown): ServiceModule[] | null {
  const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v ?? "").trim()).filter(Boolean);
  if (list.some((m) => !(SERVICE_MODULES as readonly string[]).includes(m))) return null;
  return [...new Set(list)].sort() as ServiceModule[];
}

/** Today's YYYY-MM-DD in the given time zone (for due dates, which are plain dates). */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
