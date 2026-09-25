"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";
import { getOrganizationTimezone } from "@/lib/settings/queries";

/**
 * Pass 2 (Native Calendar System): blocked time is a native Trackpr
 * concept, not a Google Calendar one - kept in its own "use server" module
 * (rather than app/(app)/appointments/actions.ts) since it operates on a
 * different table with no appointment-shaped fields (no contact/lead/
 * status), while still reusing the exact same session-resolution
 * (requireOrganization), timezone-safe wall-clock parsing
 * (zonedWallTimeToUtc), and FormState/error-mapping conventions those
 * appointment actions already established - this file duplicates
 * requireOrganization() rather than importing it, matching this
 * codebase's own existing precedent (the identical helper is already
 * independently duplicated in appointments/estimates/leads/contacts/
 * conversations/jobs' own actions.ts files).
 */

export type BlockedTimeFormState = {
  error?: string;
  success?: boolean;
};

export type DeleteBlockedTimeState = {
  error?: string;
};

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

type ParsedBlockedTime = { start_at: string; end_at: string; reason: string | null } | { error: string };

/** Same wall-clock parsing discipline as the appointment form's parseAppointmentForm - date/startTime/endTime are plain HTML inputs with no timezone attached, always interpreted as the organization's configured local time via zonedWallTimeToUtc, never naive `new Date()` parsing. */
function parseBlockedTimeForm(formData: FormData, timeZone: string): ParsedBlockedTime {
  const date = String(formData.get("date") ?? "").trim();
  const startTime = String(formData.get("startTime") ?? "").trim();
  const endTime = String(formData.get("endTime") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

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

  return { start_at: startAt.toISOString(), end_at: endAt.toISOString(), reason: reason || null };
}

export async function createBlockedTime(_prevState: BlockedTimeFormState, formData: FormData): Promise<BlockedTimeFormState> {
  const { supabase, organizationId } = await requireOrganization();
  const timeZone = (await getOrganizationTimezone(supabase, organizationId)) ?? "UTC";

  const parsed = parseBlockedTimeForm(formData, timeZone);
  if ("error" in parsed) return { error: parsed.error };

  const { error: insertError } = await supabase.from("blocked_time").insert({ ...parsed, organization_id: organizationId });

  if (insertError) {
    if (insertError.code === "23514") {
      return { error: "End time must be after the start time." };
    }
    return { error: "We couldn't block this time. Please try again." };
  }

  revalidatePath("/calendar");
  return { success: true };
}

export async function updateBlockedTime(_prevState: BlockedTimeFormState, formData: FormData): Promise<BlockedTimeFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing blocked time." };

  const { supabase, organizationId } = await requireOrganization();
  const timeZone = (await getOrganizationTimezone(supabase, organizationId)) ?? "UTC";

  const parsed = parseBlockedTimeForm(formData, timeZone);
  if ("error" in parsed) return { error: parsed.error };

  const { data, error: updateError } = await supabase
    .from("blocked_time")
    .update(parsed)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    if (updateError.code === "23514") {
      return { error: "End time must be after the start time." };
    }
    return { error: "We couldn't save these changes. Please try again." };
  }
  if (!data) {
    return { error: "This blocked time could not be found." };
  }

  revalidatePath("/calendar");
  return { success: true };
}

export async function deleteBlockedTime(_prevState: DeleteBlockedTimeState, formData: FormData): Promise<DeleteBlockedTimeState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing blocked time." };

  const { supabase, organizationId } = await requireOrganization();

  const { data, error: deleteError } = await supabase
    .from("blocked_time")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (deleteError) {
    return { error: "We couldn't remove this blocked time. Please try again." };
  }
  if (!data) {
    return { error: "This blocked time could not be found." };
  }

  revalidatePath("/calendar");
  return {};
}
