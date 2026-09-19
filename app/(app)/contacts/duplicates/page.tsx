import Link from "next/link";
import { ArrowLeft, Users2 } from "lucide-react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { findPotentialDuplicates, getContactRelationshipCounts, type ContactRelationshipCounts } from "@/lib/contacts/duplicates";
import { PageHeader } from "@/lib/ui/page-header";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { metaClass } from "@/lib/ui/typography";
import { DuplicateGroupCard } from "./_components/duplicate-group-card";

/**
 * Reachable from the Contacts page ("Review duplicates") as well as
 * directly at /contacts/duplicates.
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
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <Link
        href="/contacts"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to Contacts
      </Link>

      <div>
        <PageHeader
          title="Contact Duplicates"
          description="Contacts that share an exact phone number or email address. Reviewing and merging is manual - nothing here is merged automatically."
          badge={!canMerge ? <Badge tone="neutral">Read-only</Badge> : undefined}
        />
        {!canMerge ? (
          <p className={`mt-2 ${metaClass}`}>You have read-only access. Only owners and admins can merge contacts.</p>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={Users2}
          title="No potential duplicates found."
          description="Every contact in your organization has a unique phone number and email address."
        />
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
