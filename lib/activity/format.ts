import { isSameCalendarDay } from "@/lib/appointments/format";
import { formatCurrency } from "@/lib/dashboard/format";
import type { IconName } from "@/app/(app)/_components/icon";

const ENTITY_LABELS: Record<string, string> = {
  contact: "Contact",
  lead: "Lead",
  appointment: "Appointment",
  conversation: "Conversation",
};

const ENTITY_ICONS: Record<string, IconName> = {
  contact: "contacts",
  lead: "leads",
  appointment: "appointments",
  conversation: "conversations",
};

const ENTITY_ROUTES: Record<string, (id: string) => string> = {
  contact: (id) => `/contacts/${id}`,
  lead: (id) => `/leads/${id}`,
  appointment: (id) => `/appointments/${id}`,
  conversation: (id) => `/conversations/${id}`,
};

/**
 * `action` and `entity_type` are free text with no CHECK constraint (there
 * is no fixed vocabulary in the schema), so this must produce something
 * readable for values it has never seen, not just a known list.
 */
export function humanizeText(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Activity";
  const capitalized = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return capitalized.replace(/\bai\b/gi, "AI");
}

export function activityIcon(entityType: string | null): IconName {
  if (entityType && ENTITY_ICONS[entityType]) return ENTITY_ICONS[entityType];
  return "activity";
}

export function activityEntityLabel(entityType: string | null): string | null {
  if (!entityType) return null;
  return ENTITY_LABELS[entityType] ?? humanizeText(entityType);
}

/**
 * Only produces a link for entity types this app actually has a detail
 * route for - an unrecognized or missing entity type/id renders as plain
 * text rather than a broken link. The destination pages each independently
 * re-scope by the viewer's own organization, so a stale or mismatched id
 * here can never leak another organization's data - it would simply 404.
 */
export function activityEntityHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const buildHref = ENTITY_ROUTES[entityType];
  return buildHref ? buildHref(entityId) : null;
}

export function describeActor(entryUserId: string | null, currentUserId: string): string {
  if (!entryUserId) return "System";
  return entryUserId === currentUserId ? "You" : "Team member";
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `metadata` is unstructured jsonb with no guaranteed shape. This only ever
 * reads a handful of plausible, generically-named keys defensively and
 * falls back to omitting the detail entirely - it never renders raw JSON.
 */
export function describeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const meta = metadata as Record<string, unknown>;

  const oldStatus = asText(meta.old_status ?? meta.previous_status);
  const newStatus = asText(meta.new_status ?? meta.status);
  if (oldStatus && newStatus) {
    return `Status changed from ${humanizeText(oldStatus)} to ${humanizeText(newStatus)}`;
  }
  if (newStatus) {
    return `Status: ${humanizeText(newStatus)}`;
  }

  const parts: string[] = [];
  const name = asText(meta.name ?? meta.contact_name ?? meta.customer_name);
  if (name) parts.push(name);

  const title = asText(meta.title ?? meta.appointment_title ?? meta.service);
  if (title) parts.push(title);

  const amount = asAmount(meta.value ?? meta.estimated_value ?? meta.amount);
  if (amount != null) parts.push(formatCurrency(amount));

  return parts.length > 0 ? parts.join(" · ") : null;
}

export function getActivityDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (isSameCalendarDay(date, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";

  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function formatActivityTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
