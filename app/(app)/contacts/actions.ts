"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { isValidEmail } from "@/lib/auth/validation";
import { createClient } from "@/lib/supabase/server";

export type ContactFormState = {
  error?: string;
  success?: boolean;
};

export type DeleteContactState = {
  error?: string;
};

type ContactInput = {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  notes: string | null;
};

type ParsedContactForm = { input: ContactInput; error?: undefined } | { input?: undefined; error: string };

function parseContactForm(formData: FormData): ParsedContactForm {
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const companyName = String(formData.get("companyName") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!firstName && !lastName) {
    return { error: "Enter a first or last name for this contact." };
  }

  if (email && !isValidEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  return {
    input: {
      first_name: firstName || null,
      last_name: lastName || null,
      phone: phone || null,
      email: email || null,
      company_name: companyName || null,
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

export async function createContact(
  _prevState: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const { input, error } = parseContactForm(formData);
  if (error || !input) return { error: error ?? "Enter contact details." };

  const { supabase, organizationId } = await requireOrganization();

  const { error: insertError } = await supabase
    .from("contacts")
    .insert({ ...input, organization_id: organizationId });

  if (insertError) {
    return { error: "We couldn't create this contact. Please try again." };
  }

  revalidatePath("/contacts");
  return { success: true };
}

export async function updateContact(
  _prevState: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing contact." };
  }

  const { input, error } = parseContactForm(formData);
  if (error || !input) return { error: error ?? "Enter contact details." };

  const { supabase, organizationId } = await requireOrganization();

  const { data, error: updateError } = await supabase
    .from("contacts")
    .update(input)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return { error: "We couldn't save these changes. Please try again." };
  }

  if (!data) {
    return { error: "This contact could not be found." };
  }

  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  return { success: true };
}

export async function deleteContact(
  _prevState: DeleteContactState,
  formData: FormData,
): Promise<DeleteContactState> {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing contact." };
  }

  const { supabase, organizationId } = await requireOrganization();

  const { data, error: deleteError } = await supabase
    .from("contacts")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (deleteError) {
    if (deleteError.code === "23503") {
      return {
        error:
          "This contact can't be deleted yet because other records (such as leads or appointments) still reference it.",
      };
    }
    return { error: "We couldn't delete this contact. Please try again." };
  }

  if (!data) {
    return { error: "This contact could not be found." };
  }

  revalidatePath("/contacts");
  redirect("/contacts");
}
