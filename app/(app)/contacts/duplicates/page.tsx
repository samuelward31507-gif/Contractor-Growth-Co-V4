import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { findPotentialDuplicates, getContactRelationshipCounts, type ContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { DuplicateGroupCard } from "./_components/duplicate-group-card";

/**
 * Standalone route, not yet linked from the main Contacts page/nav - the
 * entire Contacts UI (app/(app)/contacts/) is currently part of the
 * in-progress, uncommitted Trackpr 2.0 redesign, and this feature must not
 * touch any of it (same constraint and same resolution already established
 * for /settings/sms). Reachable directly at /contacts/duplicates.
 */
export default async function ContactDuplicatesPage() {
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

  const canMerge = membership.role === "owner" || membership.role === "admin";
  const groups = await findPotentialDuplicates(supabase, membership.organizationId);

  const allContactIds = groups.flatMap((group) => group.contacts.map((c) => c.id));
  const relationshipCounts: Record<string, ContactRelationshipCounts> = {};
  await Promise.all(
    allContactIds.map(async (contactId) => {
      relationshipCounts[contactId] = await getContactRelationshipCounts(supabase, membership.organizationId, contactId);
    }),
  );

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Contact Duplicates</h1>
        <p className="mt-1 text-sm text-slate-500">
          Contacts that share an exact phone number or email address. Reviewing and merging is manual - nothing here is merged
          automatically.
        </p>
        {!canMerge ? (
          <p className="mt-3 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">
            You have read-only access. Only owners and admins can merge contacts.
          </p>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-900">No potential duplicates found.</p>
          <p className="mt-1 text-sm text-slate-500">Every contact in your organization has a unique phone number and email address.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <DuplicateGroupCard
              key={group.contacts.map((c) => c.id).join("-")}
              reason={group.reason}
              contacts={group.contacts}
              relationshipCounts={relationshipCounts}
              canMerge={canMerge}
            />
          ))}
        </div>
      )}
    </div>
  );
}
