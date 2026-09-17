"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { isValidEmail } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";
import { isValidTimezone } from "@/lib/settings/format";
import { DAYS_OF_WEEK, type DayOfWeek } from "@/lib/settings/queries";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type SettingsActionState = {
  error?: string;
  success?: boolean;
};

export type DeleteState = {
  error?: string;
};

/**
 * Resolves the caller's organization the same way every other authenticated
 * route in this app does (auth.uid() -> organization_members), then
 * requires owner/admin - members are read-only for business settings. This
 * check happens here in addition to RLS (which independently enforces the
 * same rule via is_org_admin() on every new settings table) as defense in
 * depth; authorization is never based on the UI simply hiding controls.
 */
async function requireSettingsAdmin(): Promise<{
  supabase: SupabaseServerClient;
  organizationId: string | null;
  error: string | null;
}> {
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

  if (membership.role !== "owner" && membership.role !== "admin") {
    return { supabase, organizationId: null, error: "Only owners and admins can update business settings." };
  }

  return { supabase, organizationId: membership.organizationId, error: null };
}

// ==================== Business Profile ====================

export async function updateBusinessProfile(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const state = String(formData.get("state") ?? "").trim();
  const zip = String(formData.get("zip") ?? "").trim();
  const website = String(formData.get("website") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (!name) {
    return { error: "Enter a business name." };
  }

  if (email && !isValidEmail(email)) {
    return { error: "Enter a valid business email address." };
  }

  if (!timezone || !isValidTimezone(timezone)) {
    return { error: "Select a valid timezone." };
  }

  const { error } = await supabase
    .from("organizations")
    .update({
      name,
      phone: phone || null,
      email: email || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      website: website || null,
      timezone,
    })
    .eq("id", organizationId);

  if (error) {
    return { error: "We couldn't save your business profile. Please try again." };
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { success: true };
}

// ==================== Business Hours ====================

export async function updateBusinessHours(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const rows: {
    organization_id: string;
    day_of_week: DayOfWeek;
    is_open: boolean;
    open_time: string | null;
    close_time: string | null;
  }[] = [];

  for (const { value: day, label } of DAYS_OF_WEEK) {
    const isOpen = formData.get(`${day}_isOpen`) === "on";
    const openTime = String(formData.get(`${day}_open`) ?? "").trim();
    const closeTime = String(formData.get(`${day}_close`) ?? "").trim();

    if (isOpen) {
      if (!openTime || !closeTime) {
        return { error: `Enter opening and closing times for ${label}.` };
      }
      if (closeTime <= openTime) {
        return { error: `${label}'s closing time must be after its opening time.` };
      }
    }

    rows.push({
      organization_id: organizationId,
      day_of_week: day,
      is_open: isOpen,
      open_time: isOpen ? openTime : null,
      close_time: isOpen ? closeTime : null,
    });
  }

  const { error } = await supabase
    .from("business_hours")
    .upsert(rows, { onConflict: "organization_id,day_of_week" });

  if (error) {
    return { error: "We couldn't save your business hours. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}

// ==================== Services ====================

export async function createService(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) {
    return { error: "Enter a service name." };
  }

  const { error } = await supabase.from("services").insert({
    organization_id: organizationId,
    name,
    description: description || null,
  });

  if (error) {
    return { error: "We couldn't create this service. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}

export async function updateService(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const isActive = formData.get("isActive") === "on";

  if (!id) return { error: "Missing service." };
  if (!name) return { error: "Enter a service name." };

  const { data, error } = await supabase
    .from("services")
    .update({ name, description: description || null, is_active: isActive })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: "We couldn't save these changes. Please try again." };
  }
  if (!data) {
    return { error: "This service could not be found." };
  }

  revalidatePath("/settings");
  return { success: true };
}

export async function toggleServiceActive(
  _prevState: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const id = String(formData.get("id") ?? "");
  const isActive = formData.get("isActive") === "true";
  if (!id) return { error: "Missing service." };

  const { data, error } = await supabase
    .from("services")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) return { error: "We couldn't update this service. Please try again." };
  if (!data) return { error: "This service could not be found." };

  revalidatePath("/settings");
  return {};
}

export async function deleteService(_prevState: DeleteState, formData: FormData): Promise<DeleteState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing service." };

  const { data, error } = await supabase
    .from("services")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23503") {
      return { error: "This service can't be deleted yet because other records still reference it." };
    }
    return { error: "We couldn't delete this service. Please try again." };
  }
  if (!data) {
    return { error: "This service could not be found." };
  }

  revalidatePath("/settings");
  return {};
}

// ==================== Service Areas ====================

export async function createServiceArea(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Enter an area name." };

  const { error } = await supabase.from("service_areas").insert({ organization_id: organizationId, name });

  if (error) {
    return { error: "We couldn't add this area. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}

export async function deleteServiceArea(_prevState: DeleteState, formData: FormData): Promise<DeleteState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing area." };

  const { data, error } = await supabase
    .from("service_areas")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: "We couldn't remove this area. Please try again." };
  }
  if (!data) {
    return { error: "This area could not be found." };
  }

  revalidatePath("/settings");
  return {};
}

// ==================== AI & Communication ====================

export async function updateAiSettings(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const aiEnabled = formData.get("aiEnabled") === "on";
  const tone = String(formData.get("tone") ?? "").trim();
  const businessIntroduction = String(formData.get("businessIntroduction") ?? "").trim();
  const generalInstructions = String(formData.get("generalInstructions") ?? "").trim();
  const emergencyInstructions = String(formData.get("emergencyInstructions") ?? "").trim();
  const escalationInstructions = String(formData.get("escalationInstructions") ?? "").trim();

  const { error } = await supabase.from("ai_settings").upsert(
    {
      organization_id: organizationId,
      ai_enabled: aiEnabled,
      tone: tone || null,
      business_introduction: businessIntroduction || null,
      general_instructions: generalInstructions || null,
      emergency_instructions: emergencyInstructions || null,
      escalation_instructions: escalationInstructions || null,
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    return { error: "We couldn't save your AI settings. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}

// ==================== Booking ====================

function parseMinutes(
  raw: string,
  label: string,
  { allowZero = true }: { allowZero?: boolean } = {},
): { value?: number; error?: string } {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);

  if (trimmed === "" || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { error: `Enter a valid number of minutes for ${label}.` };
  }

  if (allowZero ? parsed < 0 : parsed <= 0) {
    return { error: `${label} must be ${allowZero ? "zero or greater" : "greater than zero"}.` };
  }

  return { value: parsed };
}

export async function updateBookingSettings(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const bookingEnabled = formData.get("bookingEnabled") === "on";

  const minimumNotice = parseMinutes(String(formData.get("minimumNoticeMinutes") ?? ""), "Minimum notice");
  if (minimumNotice.error) return { error: minimumNotice.error };

  const defaultDuration = parseMinutes(
    String(formData.get("defaultDurationMinutes") ?? ""),
    "Default appointment duration",
    { allowZero: false },
  );
  if (defaultDuration.error) return { error: defaultDuration.error };

  const buffer = parseMinutes(String(formData.get("bufferMinutes") ?? ""), "Buffer between appointments");
  if (buffer.error) return { error: buffer.error };

  const { error } = await supabase.from("booking_settings").upsert(
    {
      organization_id: organizationId,
      booking_enabled: bookingEnabled,
      minimum_notice_minutes: minimumNotice.value,
      default_duration_minutes: defaultDuration.value,
      buffer_minutes: buffer.value,
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    return { error: "We couldn't save your booking settings. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}

// ==================== Notifications ====================

export async function updateNotificationSettings(
  _prevState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const { supabase, organizationId, error: authError } = await requireSettingsAdmin();
  if (authError || !organizationId) return { error: authError ?? "Something went wrong. Please try again." };

  const notificationEmail = String(formData.get("notificationEmail") ?? "").trim();
  const notificationPhone = String(formData.get("notificationPhone") ?? "").trim();

  if (notificationEmail && !isValidEmail(notificationEmail)) {
    return { error: "Enter a valid notification email address." };
  }

  const { error } = await supabase.from("notification_settings").upsert(
    {
      organization_id: organizationId,
      notification_email: notificationEmail || null,
      notification_phone: notificationPhone || null,
      notify_on_hot_lead: formData.get("notifyOnHotLead") === "on",
      notify_on_ai_escalation: formData.get("notifyOnAiEscalation") === "on",
      notify_on_missed_call: formData.get("notifyOnMissedCall") === "on",
      notify_on_appointment_booked: formData.get("notifyOnAppointmentBooked") === "on",
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    return { error: "We couldn't save your notification preferences. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}
