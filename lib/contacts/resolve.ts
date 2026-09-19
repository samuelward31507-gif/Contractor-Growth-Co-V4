import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "./queries";
import { normalizePhoneForIdentity, normalizeEmailForIdentity } from "./identity";

const CONTACT_COLUMNS = "id, first_name, last_name, phone, email, company_name, notes, created_at, updated_at";

export type ResolveOrCreateContactInput = {
  organizationId: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  companyName?: string | null;
  notes?: string | null;
};

export type ResolveOrCreateContactResult =
  | { outcome: "matched"; contact: Contact }
  | { outcome: "created"; contact: Contact }
  /** Phone matches one existing contact and email matches a DIFFERENT existing contact - never guessed at, never merged automatically. */
  | { outcome: "conflict"; phoneMatch: Contact; emailMatch: Contact }
  | { outcome: "error"; error: string };

async function findActiveByNormalizedPhone(supabase: SupabaseClient, organizationId: string, phoneNormalized: string): Promise<Contact | null> {
  const { data } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("phone_normalized", phoneNormalized)
    .is("merged_into_id", null)
    .maybeSingle();
  return (data as Contact | null) ?? null;
}

async function findActiveByNormalizedEmail(supabase: SupabaseClient, organizationId: string, emailNormalized: string): Promise<Contact | null> {
  const { data } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("email_normalized", emailNormalized)
    .is("merged_into_id", null)
    .maybeSingle();
  return (data as Contact | null) ?? null;
}

/**
 * Contact Deduplication V1 - the single, centralized resolver every
 * production contact-creation path must use (app/(app)/contacts/actions.ts's
 * createContact, and app/api/webhooks/sms/inbound/route.ts's
 * lookup-or-create-on-first-message). Never trusts a client-supplied
 * organizationId beyond what the caller already resolved server-side
 * (getUserOrganization for an authenticated action, the sms_phone_number
 * lookup for the inbound webhook) - this function scopes every query to
 * exactly that organizationId and nothing else.
 *
 * Matching is strong-identity only (exact normalized phone, exact
 * normalized email) - name is never used to find or merge a contact
 * automatically (see lib/contacts/identity.ts's own documentation for why).
 * An ambiguous/unnormalizable phone or email is simply not used for
 * matching at all - it still gets stored on a newly created contact, it
 * just never contributes to finding an existing one.
 *
 * Race-condition safety: the actual integrity boundary is the database's
 * own partial unique indexes on (organization_id, phone_normalized) and
 * (organization_id, email_normalized) - see the migration. This function
 * does a SELECT-then-INSERT, which is race-prone by itself, but a 23505
 * unique-violation from the INSERT (two concurrent callers both missing the
 * initial SELECT) is caught and resolved by re-reading the row the other
 * caller just won, never surfaced as a duplicate or an error.
 */
export async function resolveOrCreateContact(
  supabase: SupabaseClient,
  input: ResolveOrCreateContactInput,
): Promise<ResolveOrCreateContactResult> {
  const phoneNormalized = normalizePhoneForIdentity(input.phone);
  const emailNormalized = normalizeEmailForIdentity(input.email);

  const [phoneMatch, emailMatch] = await Promise.all([
    phoneNormalized ? findActiveByNormalizedPhone(supabase, input.organizationId, phoneNormalized) : Promise.resolve(null),
    emailNormalized ? findActiveByNormalizedEmail(supabase, input.organizationId, emailNormalized) : Promise.resolve(null),
  ]);

  if (phoneMatch && emailMatch) {
    if (phoneMatch.id === emailMatch.id) {
      return { outcome: "matched", contact: phoneMatch };
    }
    // Different contacts each match one identity field - a real conflict,
    // never resolved automatically (Step 6's explicit requirement).
    return { outcome: "conflict", phoneMatch, emailMatch };
  }

  if (phoneMatch) return { outcome: "matched", contact: phoneMatch };
  if (emailMatch) return { outcome: "matched", contact: emailMatch };

  const { data: created, error } = await supabase
    .from("contacts")
    .insert({
      organization_id: input.organizationId,
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      phone: input.phone ?? null,
      phone_normalized: phoneNormalized,
      email: input.email ?? null,
      email_normalized: emailNormalized,
      company_name: input.companyName ?? null,
      notes: input.notes ?? null,
    })
    .select(CONTACT_COLUMNS)
    .single();

  if (!error) {
    return { outcome: "created", contact: created as Contact };
  }

  if (error.code === "23505") {
    // Lost a real race: another concurrent request for the same normalized
    // identity committed first. Re-read whichever unique index it hit
    // rather than treating this as a failure.
    const winner = (phoneNormalized ? await findActiveByNormalizedPhone(supabase, input.organizationId, phoneNormalized) : null) ??
      (emailNormalized ? await findActiveByNormalizedEmail(supabase, input.organizationId, emailNormalized) : null);
    if (winner) return { outcome: "matched", contact: winner };
    return { outcome: "error", error: "A matching contact was created concurrently but could not be re-read." };
  }

  return { outcome: "error", error: "We couldn't create this contact. Please try again." };
}
