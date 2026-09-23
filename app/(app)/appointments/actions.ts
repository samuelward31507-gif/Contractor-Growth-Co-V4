"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "@/lib/appointments/queries";
import { checkAppointmentOverlap } from "@/lib/appointments/overlap";
import { emitAppointmentCreated, emitAppointmentNoShow, emitAppointmentLifecycleEvent } from "@/lib/automation/appointments";
import { syncAppointmentCreatedToGoogle, syncAppointmentUpdatedToGoogle, syncAppointmentRemovedFromGoogle } from "@/lib/calendar/appointment-sync";
import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";
import { getOrganizationTimezone } from "@/lib/settings/queries";

export type AppointmentFormState = {
  error?: string;
  success?: boolean;
  /** Phase 1 Scheduling Foundation, Stage 5: set only when the Trackpr write itself succeeded but syncing the change to Google Calendar needs attention - never a reason to treat the save as failed. */
  warning?: string;
};

export type DeleteAppointmentState = {
  error?: string;
};

/** The conflict message Stage 1's application-level pre-check already uses - reused verbatim so a race that only the database's own exclusion constraint catches (23P01) is indistinguishable to the user from the ordinary pre-check catching it first. */
const APPOINTMENT_CONFLICT_ERROR = "This time conflicts with another appointment. Choose a different time.";

type AppointmentInput = {
  contact_id: string;
  lead_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  notes: string | null;
};

const VALID_STATUSES = new Set<string>(APPOINTMENT_STATUSES.map((item) => item.value));

type ParsedAppointmentForm =
  | { input: AppointmentInput; error?: undefined }
  | { input?: undefined; error: string };

/**
 * date/startTime/endTime come from plain HTML date/time inputs - "YYYY-MM-DD"
 * and "HH:MM", with no timezone attached, because the browser has no idea
 * what timezone the organization operates in. They represent wall-clock time
 * AS THE CONTRACTOR MEANT IT (the organization's configured timezone), not
 * server-local time - the server runs in UTC in production, so naively doing
 * `new Date(`${date}T${startTime}`)` silently interpreted every entry as UTC
 * (a real production bug: 2:00 PM entered was stored and later displayed as
 * 7:00 AM). zonedWallTimeToUtc is the same DST-safe conversion already used
 * for availability/booking - reused here rather than reimplemented.
 */
function parseAppointmentForm(formData: FormData, timeZone: string): ParsedAppointmentForm {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  const startTime = String(formData.get("startTime") ?? "").trim();
  const endTime = String(formData.get("endTime") ?? "").trim();
  const statusRaw = String(formData.get("status") ?? "scheduled").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!contactId) {
    return { error: "Select a contact for this appointment." };
  }

  if (!title) {
    return { error: "Enter a title for this appointment." };
  }

  if (!date || !startTime || !endTime) {
    return { error: "Enter a date, start time, and end time." };
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const startMatch = /^(\d{1,2}):(\d{2})$/.exec(startTime);
  const endMatch = /^(\d{1,2}):(\d{2})$/.exec(endTime);

  if (!dateMatch || !startMatch || !endMatch) {
    return { error: "Enter a valid date and time." };
  }

  const [, yearStr, monthStr, dayStr] = dateMatch;
  const [, startHourStr, startMinuteStr] = startMatch;
  const [, endHourStr, endMinuteStr] = endMatch;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const startMinutesSinceMidnight = Number(startHourStr) * 60 + Number(startMinuteStr);
  const endMinutesSinceMidnight = Number(endHourStr) * 60 + Number(endMinuteStr);

  const startAt = zonedWallTimeToUtc(year, month, day, startMinutesSinceMidnight, timeZone);
  const endAt = zonedWallTimeToUtc(year, month, day, endMinutesSinceMidnight, timeZone);

  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return { error: "Enter a valid date and time." };
  }

  if (endAt.getTime() <= startAt.getTime()) {
    return { error: "End time must be after the start time." };
  }

  const status = (VALID_STATUSES.has(statusRaw) ? statusRaw : "scheduled") as AppointmentStatus;

  return {
    input: {
      contact_id: contactId,
      lead_id: leadId || null,
      title,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status,
      notes: notes || null,
    },
  };
}

/**
 * Resolves the caller's organization the same way every other authenticated
 * route in this app does (auth.uid() -> organization_members). Never trusts
 * a client-supplied organization id.
 */
async function requireOrganization() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  return { supabase, organizationId: membership.organizationId };
}

async function verifyContactInOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  return Boolean(data);
}

/**
 * Confirms the selected lead belongs to the caller's organization AND is
 * associated with the same contact chosen for this appointment. Never
 * trusts client-side filtering for this relationship - the lead picker only
 * filters leads by contact for UX; this is the actual security check.
 */
async function verifyLeadForContact(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  leadId: string,
  contactId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data) return false;
  return data.contact_id === contactId;
}

async function validateRelationships(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  input: AppointmentInput,
  excludeId?: string,
): Promise<string | null> {
  const contactValid = await verifyContactInOrganization(supabase, organizationId, input.contact_id);
  if (!contactValid) {
    return "Select a valid contact.";
  }

  if (input.lead_id) {
    const leadValid = await verifyLeadForContact(supabase, organizationId, input.lead_id, input.contact_id);
    if (!leadValid) {
      return "Select a valid lead for this contact.";
    }
  }

  const hasOverlap = await checkAppointmentOverlap(supabase, organizationId, input, excludeId);
  if (hasOverlap) {
    return APPOINTMENT_CONFLICT_ERROR;
  }

  return null;
}

export async function createAppointment(
  _prevState: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const { supabase, organizationId } = await requireOrganization();
  const timeZone = (await getOrganizationTimezone(supabase, organizationId)) ?? "UTC";

  const { input, error } = parseAppointmentForm(formData, timeZone);
  if (error || !input) return { error: error ?? "Enter appointment details." };

  const relationshipError = await validateRelationships(supabase, organizationId, input);
  if (relationshipError) {
    return { error: relationshipError };
  }

  const { data: created, error: insertError } = await supabase
    .from("appointments")
    .insert({ ...input, organization_id: organizationId })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23514") {
      return { error: "End time must be after the start time." };
    }
    // Phase 1 Scheduling Foundation, Stage 1's appointments_no_overlap
    // exclusion constraint (23P01) is the actual concurrency guarantee -
    // the checkAppointmentOverlap() pre-check above is only a fast,
    // friendly path that catches the common case before ever reaching the
    // database. A race between two near-simultaneous requests can still
    // both pass that pre-check; the constraint is what makes exactly one
    // of them succeed, and the loser lands here needing the exact same
    // user-facing message the pre-check already gives, not a generic
    // "something went wrong".
    if (insertError.code === "23P01") {
      return { error: APPOINTMENT_CONFLICT_ERROR };
    }
    return { error: "We couldn't create this appointment. Please try again." };
  }

  let warning: string | undefined;
  if (created) {
    await emitAppointmentCreated(supabase, created.id);
    // Google Calendar sync (Stage 5) is deliberately a separate, independent
    // step from the n8n/AI confirmation-message automation above - a
    // calendar sync failure must never affect, or be affected by, that
    // automation, and vice versa. The Trackpr appointment above is already
    // fully committed by this point regardless of what happens next.
    const syncResult = await syncAppointmentCreatedToGoogle(supabase, organizationId, created.id);
    warning = syncResult.warning;
  }

  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  return { success: true, warning };
}

export async function updateAppointment(
  _prevState: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing appointment." };
  }

  const { supabase, organizationId } = await requireOrganization();
  const timeZone = (await getOrganizationTimezone(supabase, organizationId)) ?? "UTC";

  const { input, error } = parseAppointmentForm(formData, timeZone);
  if (error || !input) return { error: error ?? "Enter appointment details." };

  const relationshipError = await validateRelationships(supabase, organizationId, input, id);
  if (relationshipError) {
    return { error: relationshipError };
  }

  // Read before write: appointment lifecycle automation (Phase 4.4) is
  // driven by comparing the prior state to the new one - this single,
  // generic update is the only place status/time transitions happen, so
  // detecting "what actually changed" here is the only way to know which
  // automation event(s), if any, a given save represents. external_event_id/
  // external_calendar_id (Stage 5) are read in this same query for the
  // identical reason - whether and how to sync this save to Google depends
  // on whether the appointment already had a synced event before this write.
  const { data: previous } = await supabase
    .from("appointments")
    .select("status, start_at, end_at, external_event_id, external_calendar_id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const { data, error: updateError } = await supabase
    .from("appointments")
    .update(input)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, updated_at")
    .maybeSingle();

  if (updateError) {
    if (updateError.code === "23514") {
      return { error: "End time must be after the start time." };
    }
    // See createAppointment's identical handling above - the same race
    // Stage 1's exclusion constraint guards against on insert can also
    // occur here (e.g. two concurrent reschedules landing on the same
    // slot).
    if (updateError.code === "23P01") {
      return { error: APPOINTMENT_CONFLICT_ERROR };
    }
    return { error: "We couldn't save these changes. Please try again." };
  }

  if (!data) {
    return { error: "This appointment could not be found." };
  }

  let warning: string | undefined;
  if (previous) {
    await emitAppointmentTransitions(supabase, id, previous, { status: input.status, start_at: input.start_at, end_at: input.end_at, updated_at: data.updated_at });
    warning = await syncAppointmentEditToGoogle(supabase, organizationId, id, previous, input.status);
  }

  revalidatePath("/appointments");
  revalidatePath(`/appointments/${id}`);
  revalidatePath("/dashboard");
  return { success: true, warning };
}

/**
 * Phase 1 Scheduling Foundation, Stage 5: decides which Google Calendar
 * sync action (if any) this specific save represents, then performs it.
 * An appointment newly transitioning to 'cancelled' has its Google event
 * DELETED (not updated to show "cancelled") and its external ids cleared -
 * per this stage's own domain semantics, a cancelled appointment no longer
 * needs to occupy time on the contractor's calendar, and clearing the ids
 * keeps any future save from trying to update an event that no longer
 * exists. Any other save to an already-synced appointment updates its
 * event. An appointment with no synced event is never touched here - see
 * syncAppointmentUpdatedToGoogle's own comment for why this stage
 * deliberately never auto-creates one on an unrelated edit.
 */
async function syncAppointmentEditToGoogle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  appointmentId: string,
  previous: { status: AppointmentStatus; external_event_id: string | null; external_calendar_id: string | null },
  nextStatus: AppointmentStatus,
): Promise<string | undefined> {
  const newlyCancelled = previous.status !== "cancelled" && nextStatus === "cancelled";

  if (newlyCancelled && previous.external_event_id && previous.external_calendar_id) {
    const result = await syncAppointmentRemovedFromGoogle(supabase, organizationId, previous.external_event_id, previous.external_calendar_id);
    if (!result.warning) {
      await supabase.from("appointments").update({ external_event_id: null, external_calendar_id: null }).eq("id", appointmentId).eq("organization_id", organizationId);
    }
    return result.warning;
  }

  if (!newlyCancelled && previous.external_event_id) {
    const result = await syncAppointmentUpdatedToGoogle(supabase, organizationId, appointmentId);
    return result.warning;
  }

  return undefined;
}

/**
 * Emits the Phase 4.4 appointment lifecycle automation event(s), if any,
 * implied by a single updateAppointment() save. At most one of
 * cancelled/completed/no_show fires (status is a single enum value), plus
 * independently a rescheduled event if start/end time changed and the
 * appointment isn't simultaneously being cancelled (a cancelled appointment
 * has nothing to reschedule a reminder for).
 */
async function emitAppointmentTransitions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  appointmentId: string,
  previous: { status: AppointmentStatus; start_at: string; end_at: string },
  next: { status: AppointmentStatus; start_at: string; end_at: string; updated_at: string },
): Promise<void> {
  if (previous.status !== "cancelled" && next.status === "cancelled") {
    await emitAppointmentLifecycleEvent(supabase, appointmentId, "appointment.cancelled");
    return;
  }

  if (previous.status !== "completed" && next.status === "completed") {
    await emitAppointmentLifecycleEvent(supabase, appointmentId, "appointment.completed");
  } else if (previous.status !== "no_show" && next.status === "no_show") {
    await emitAppointmentNoShow(supabase, appointmentId);
  }

  const timeChanged = previous.start_at !== next.start_at || previous.end_at !== next.end_at;
  if (timeChanged) {
    await emitAppointmentLifecycleEvent(supabase, appointmentId, "appointment.rescheduled", next.updated_at);
  }
}

export async function deleteAppointment(
  _prevState: DeleteAppointmentState,
  formData: FormData,
): Promise<DeleteAppointmentState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing appointment." };
  }

  const { supabase, organizationId } = await requireOrganization();

  // external_event_id/external_calendar_id (Stage 5) are selected as part
  // of this same DELETE ... RETURNING - the only chance to capture them,
  // since the row itself is gone immediately after. Trackpr's own delete
  // happens first and unconditionally; Google sync below only ever runs
  // once it has already succeeded, never the reverse.
  const { data, error: deleteError } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, external_event_id, external_calendar_id")
    .maybeSingle();

  if (deleteError) {
    if (deleteError.code === "23503") {
      return {
        error: "This appointment can't be deleted yet because other records still reference it.",
      };
    }
    return { error: "We couldn't delete this appointment. Please try again." };
  }

  if (!data) {
    return { error: "This appointment could not be found." };
  }

  if (data.external_event_id && data.external_calendar_id) {
    // Best-effort, matching every other Google sync call in this file -
    // never undoes the already-committed Trackpr deletion. A failure here
    // has nowhere to be surfaced (this action redirects immediately after),
    // but is still logged server-side via syncAppointmentRemovedFromGoogle's
    // own console.error, and the connection's own status/last_error (Stage
    // 3/4) already records it durably if the cause was connection-level.
    await syncAppointmentRemovedFromGoogle(supabase, organizationId, data.external_event_id, data.external_calendar_id);
  }

  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  redirect("/appointments");
}
