import Link from "next/link";
import { Users2 } from "lucide-react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { filterContacts, getContacts, type Contact } from "@/lib/contacts/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { AddContactButton } from "./_components/add-contact-button";
import { ContactsEmptyState } from "./_components/contacts-empty-state";
import { ContactsSearch } from "./_components/contacts-search";
import { ContactsTable } from "./_components/contacts-table";

export type ContactSort = "newest" | "oldest" | "name_asc";
const VALID_SORTS = new Set<string>(["newest", "oldest", "name_asc"]);

function normalizeSort(value: string | undefined): ContactSort {
  return value && VALID_SORTS.has(value) ? (value as ContactSort) : "newest";
}

function contactSortName(contact: Contact): string {
  return [contact.last_name, contact.first_name].filter(Boolean).join(" ").trim().toLowerCase() || "zzz";
}

/** Presentation-only ordering of an already-fetched, org-scoped contact list - mirrors filterContacts' "filter in memory" pattern. */
function sortContacts(contacts: Contact[], sort: ContactSort): Contact[] {
  const sorted = [...contacts];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      break;
    case "name_asc":
      sorted.sort((a, b) => contactSortName(a).localeCompare(contactSortName(b)));
      break;
    case "newest":
    default:
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }
  return sorted;
}

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const sort = normalizeSort(typeof params.sort === "string" ? params.sort : undefined);

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

  const allContacts = await getContacts(supabase, membership.organizationId);
  const contacts = sortContacts(filterContacts(allContacts, query), sort);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Contacts"
        description="Manage the people and customers connected to your business."
        badge={
          allContacts.length > 0 ? (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">
              {allContacts.length}
            </span>
          ) : undefined
        }
        action={
          <div className="flex items-center gap-3">
            <Link
              href="/contacts/duplicates"
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
            >
              <Users2 className="h-4 w-4" aria-hidden />
              Review duplicates
            </Link>
            <AddContactButton />
          </div>
        }
      />

      {allContacts.length === 0 ? (
        <ContactsEmptyState />
      ) : (
        <Panel>
          <ContactsSearch initialQuery={query} initialSort={sort} />
          <div className="mt-5">
            <ContactsTable contacts={contacts} query={query} />
          </div>
        </Panel>
      )}
    </div>
  );
}
