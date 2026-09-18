"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "@/lib/appointments/queries";
import { emitAppointmentCreated, emitAppointmentNoShow, emitAppointmentLifecycleEvent } from "@/lib/automation/appointments";

export type AppointmentFormState = {
  error?: string;
  success?: boolean;
};

export type DeleteAppointmentState = {
  error?: string;
};

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

function parseAppointmentForm(formData: FormData): ParsedAppointmentForm {
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

  const startAt = new Date(`${date}T${startTime}`);
  const endAt = new Date(`${date}T${endTime}`);

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

  return null;
}

export async function createAppointment(
  _prevState: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const { input, error } = parseAppointmentForm(formData);
  if (error || !input) return { error: error ?? "Enter appointment details." };

  const { supabase, organizationId } = await requireOrganization();

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
    return { error: "We couldn't create this appointment. Please try again." };
  }

  if (created) {
    await emitAppointmentCreated(supabase, created.id);
  }

  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  return { success: true };
}

export async function updateAppointment(
  _prevState: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing appointment." };
  }

  const { input, error } = parseAppointmentForm(formData);
  if (error || !input) return { error: error ?? "Enter appointment details." };

  const { supabase, organizationId } = await requireOrganization();

  const relationshipError = await validateRelationships(supabase, organizationId, input);
  if (relationshipError) {
    return { error: relationshipError };
  }

  // Read before write: appointment lifecycle automation (Phase 4.4) is
  // driven by comparing the prior state to the new one - this single,
  // generic update is the only place status/time transitions happen, so
  // detecting "what actually changed" here is the only way to know which
  // automation event(s), if any, a given save represents.
  const { data: previous } = await supabase
    .from("appointments")
    .select("status, start_at, end_at")
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
    return { error: "We couldn't save these changes. Please try again." };
  }

  if (!data) {
    return { error: "This appointment could not be found." };
  }

  if (previous) {
    await emitAppointmentTransitions(supabase, id, previous, { status: input.status, start_at: input.start_at, end_at: input.end_at, updated_at: data.updated_at });
  }

  revalidatePath("/appointments");
  revalidatePath(`/appointments/${id}`);
  revalidatePath("/dashboard");
  return { success: true };
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

  const { data, error: deleteError } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
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

  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  redirect("/appointments");
}
