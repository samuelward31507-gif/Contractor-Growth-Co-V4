"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { assertOrgAdmin } from "@/lib/automation/authorization";
import { isCustomerReplySimulationEnvironment, simulateInboundCustomerReply, validateSimulatedReply } from "@/lib/messaging/simulate-customer-reply";
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

export type SimulateCustomerReplyState = {
  error?: string;
  success?: boolean;
  duplicate?: boolean;
};

/**
 * TEST-only: records a customer reply in this conversation without Twilio
 * and runs it through the real inbound-reply path (see lib/messaging/
 * simulate-customer-reply.ts). Every guard is re-checked here on each call,
 * never trusted from the page that rendered the form:
 * non-production deployment, org owner/admin, organization still in TEST
 * mode, and the conversation being this organization's open SMS thread with
 * a contact. Sends nothing - any AI reply it leads to is denied by
 * evaluateOutboundGate()'s organization_not_live check.
 *
 * The service-role client is used only after those checks pass, for the
 * same reason the real Twilio webhook uses it: the inbound-reply pipeline
 * (customer-reply event/execution *AsService helpers, reply classifiers) is
 * service-role code. Same precedent as settings/team/actions.ts, which also
 * uses it only after verifying an org admin.
 */
export async function simulateCustomerReply(
  _prevState: SimulateCustomerReplyState,
  formData: FormData,
): Promise<SimulateCustomerReplyState> {
  if (!isCustomerReplySimulationEnvironment()) {
    return { error: "Simulating customer replies is only available on test deployments." };
  }

  const conversationId = String(formData.get("conversationId") ?? "");
  const simulationId = String(formData.get("simulationId") ?? "");
  const validation = validateSimulatedReply(String(formData.get("body") ?? ""), simulationId);
  if (!validation.ok) {
    return { error: validation.error };
  }
  if (!conversationId) {
    return { error: "Missing conversation." };
  }

  const { supabase, organizationId } = await requireOrganization();

  const admin = await assertOrgAdmin(supabase, organizationId);
  if (!admin.ok) {
    return { error: admin.error };
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("automation_mode")
    .eq("id", organizationId)
    .maybeSingle();
  if (organization?.automation_mode !== "test") {
    return { error: "Simulating customer replies is only available while automations are in TEST mode." };
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, contact_id, channel, status")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!conversation) {
    return { error: "This conversation could not be found." };
  }
  // The real webhook always lands a reply in the contact's one open SMS
  // conversation (findOrCreateOpenConversation) - simulate only into that.
  if (!conversation.contact_id || conversation.channel !== "sms" || conversation.status !== "open") {
    return { error: "Customer replies can only be simulated in an open SMS conversation with a contact." };
  }

  const result = await simulateInboundCustomerReply(createServiceRoleClient(), {
    organizationId,
    contactId: conversation.contact_id,
    conversationId: conversation.id,
    body: validation.body,
    simulationId,
  });
  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath("/conversations");
  return { success: true, duplicate: result.duplicate };
}
