import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { filterContacts, getContacts } from "@/lib/contacts/queries";
import { AddContactButton } from "./_components/add-contact-button";
import { ContactsEmptyState } from "./_components/contacts-empty-state";
import { ContactsSearch } from "./_components/contacts-search";
import { ContactsTable } from "./_components/contacts-table";

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";

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
  const contacts = filterContacts(allContacts, query);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Contacts</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage the people and customers connected to your business.
          </p>
        </div>
        <AddContactButton />
      </div>

      {allContacts.length === 0 ? (
        <ContactsEmptyState />
      ) : (
        <>
          <ContactsSearch initialQuery={query} />
          <ContactsTable contacts={contacts} query={query} />
        </>
      )}
    </div>
  );
}
