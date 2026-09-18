"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { CONVERSATION_STATUSES, type ConversationStatus } from "@/lib/conversations/queries";

export type ConversationActionState = {
  error?: string;
};

export type MessageFormState = {
  error?: string;
  success?: boolean;
};

const VALID_STATUSES = new Set<string>(CONVERSATION_STATUSES.map((item) => item.value));

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

async function verifyConversationInOrganization(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  return Boolean(data);
}

export async function setConversationStatus(
  _prevState: ConversationActionState,
  formData: FormData,
): Promise<ConversationActionState> {
  const id = String(formData.get("id") ?? "");
  const statusRaw = String(formData.get("status") ?? "");

  if (!id || !VALID_STATUSES.has(statusRaw)) {
    return { error: "Something went wrong. Please try again." };
  }

  const status = statusRaw as ConversationStatus;
  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("conversations")
    .update({ status })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: "We couldn't update this conversation. Please try again." };
  }

  if (!data) {
    return { error: "This conversation could not be found." };
  }

  revalidatePath("/conversations");
  revalidatePath(`/conversations/${id}`);
  return {};
}

export async function setConversationAiEnabled(
  _prevState: ConversationActionState,
  formData: FormData,
): Promise<ConversationActionState> {
  const id = String(formData.get("id") ?? "");
  const aiEnabledRaw = String(formData.get("aiEnabled") ?? "");

  if (!id || (aiEnabledRaw !== "true" && aiEnabledRaw !== "false")) {
    return { error: "Something went wrong. Please try again." };
  }

  const { supabase, organizationId } = await requireOrganization();

  const { data, error } = await supabase
    .from("conversations")
    .update({ ai_enabled: aiEnabledRaw === "true" })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: "We couldn't update this conversation. Please try again." };
  }

  if (!data) {
    return { error: "This conversation could not be found." };
  }

  revalidatePath("/conversations");
  revalidatePath(`/conversations/${id}`);
  return {};
}

/**
 * Logs a manually-written message on the conversation history. This is a
 * CRM record only - it is never actually transmitted through SMS, email, or
 * any other channel, so it is always stored as sender_type "user" with no
 * provider_message_id. The UI must make this distinction explicit to the
 * contractor; this action never pretends the message was delivered.
 */
export async function createMessage(
  _prevState: MessageFormState,
  formData: FormData,
): Promise<MessageFormState> {
  const conversationId = String(formData.get("conversationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!conversationId) {
    return { error: "Missing conversation." };
  }

  if (!body) {
    return { error: "Enter a message before logging it." };
  }

  const { supabase, organizationId } = await requireOrganization();

  const conversationValid = await verifyConversationInOrganization(supabase, organizationId, conversationId);
  if (!conversationValid) {
    return { error: "This conversation could not be found." };
  }

  const { error } = await supabase.from("messages").insert({
    organization_id: organizationId,
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "user",
    body,
    status: "logged",
  });

  if (error) {
    return { error: "We couldn't log this message. Please try again." };
  }

  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath("/conversations");
  return { success: true };
}
