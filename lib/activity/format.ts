import { isSameCalendarDay } from "@/lib/appointments/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { Contact, Users, CalendarClock, MessageSquare, Receipt, Wallet, Activity as ActivityIcon, type LucideIcon } from "lucide-react";
import { addDaysToCalendarDate, calendarDateInTimeZone, formatInvoiceNumber, formatMoney, labelStatus, PAYMENT_METHODS, type InvoiceStatus } from "@/lib/invoices/domain";
import { safeTimeZone } from "@/lib/bi/date-range";

const ENTITY_LABELS: Record<string, string> = {
  contact: "Contact",
  lead: "Lead",
  appointment: "Appointment",
  conversation: "Conversation",
  // Phase 1B-3: money events written by create_invoice_audit_event.
  invoice: "Invoice",
  customer_payment: "Payment",
};

/** Same icon choice per entity type as the main nav (app/(app)/_components/nav-items.ts) - Contacts/Leads/Appointments/Conversations - so an activity row and its destination page always agree visually. */
const ENTITY_ICONS: Record<string, LucideIcon> = {
  contact: Contact,
  lead: Users,
  appointment: CalendarClock,
  conversation: MessageSquare,
  invoice: Receipt,
  customer_payment: Wallet,
};

const ENTITY_ROUTES: Record<string, (id: string, metadata?: unknown) => string | null> = {
  contact: (id) => `/people/${id}`,
  lead: (id) => `/leads/${id}`,
  appointment: (id) => `/appointments/${id}`,
  conversation: (id) => `/conversations/${id}`,
  invoice: (id) => `/invoices/${id}`,
  // A payment has no page of its own; its audit metadata carries the
  // invoice it belongs to (see lib/invoices/service.ts recordAudit).
  customer_payment: (_id, metadata) => {
    const invoiceId = metadataText(metadata, "invoice_id");
    return invoiceId ? `/invoices/${invoiceId}` : null;
  },
};

function metadataText(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

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

export function activityIcon(entityType: string | null): LucideIcon {
  if (entityType && ENTITY_ICONS[entityType]) return ENTITY_ICONS[entityType];
  return ActivityIcon;
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
export function activityEntityHref(entityType: string | null, entityId: string | null, metadata?: unknown): string | null {
  if (!entityType || !entityId) return null;
  const buildHref = ENTITY_ROUTES[entityType];
  return buildHref ? buildHref(entityId, metadata) : null;
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

  // Phase 1B-3: invoice/payment audit rows (create_invoice_audit_event)
  // always carry the invoice `number`; describe them in money terms so the
  // timeline reads "INV-000007 · $1,300.25 · Check · now Partially paid".
  const invoiceNumber = typeof meta.number === "number" && Number.isInteger(meta.number) && meta.number > 0 ? meta.number : null;
  if (invoiceNumber != null) {
    const parts: string[] = [formatInvoiceNumber(invoiceNumber)];
    const money = asAmount(meta.amount ?? meta.total);
    if (money != null) parts.push(formatMoney(money));
    const method = asText(meta.method);
    if (method) parts.push(PAYMENT_METHODS.find((item) => item.value === method)?.label ?? humanizeText(method));
    const statusAfter = asText(meta.invoice_status_after);
    if (statusAfter) parts.push(`now ${labelStatus(statusAfter as InvoiceStatus)}`);
    const dueDate = asText(meta.due_date);
    if (dueDate) parts.push(`due ${dueDate}`);
    const reason = asText(meta.reason);
    if (reason) parts.push(`Reason: ${reason}`);
    return parts.join(" · ");
  }

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

export function getActivityDayLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  // Phase 2A: with an organization timezone (Analytics), "Today" and
  // "Yesterday" are the organization's calendar days and the heading date is
  // formatted in its zone. Omitted, the original server-local behavior.
  if (timeZone !== undefined) {
    const zone = safeTimeZone(timeZone);
    const day = calendarDateInTimeZone(new Date(iso), zone);
    const today = calendarDateInTimeZone(now, zone);
    if (day === today) return "Today";
    if (day === addDaysToCalendarDate(today, -1)) return "Yesterday";
    return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone });
  }

  const date = new Date(iso);
  if (isSameCalendarDay(date, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";

  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function formatActivityTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone !== undefined ? { timeZone: safeTimeZone(timeZone) } : {}) });
}
