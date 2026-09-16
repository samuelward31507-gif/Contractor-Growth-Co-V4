import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContact } from "@/lib/contacts/queries";
import { contactDisplayName, contactInitials, formatContactDate } from "@/lib/contacts/format";
import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { Icon } from "../../_components/icon";
import { ContactActions } from "./_components/contact-actions";

export default async function ContactDetailPage({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;

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

  const contact = await getContact(supabase, membership.organizationId, id);

  if (!contact) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Contact not found</h1>
        <p className="text-sm text-slate-500">This contact may have been deleted, or the link is incorrect.</p>
        <Link href="/contacts" className="mt-2 text-sm font-medium text-slate-900 hover:underline">
          Back to Contacts
        </Link>
      </div>
    );
  }

  const name = contactDisplayName(contact);
  const infoFields: { label: string; value: string | null }[] = [
    { label: "Phone", value: contact.phone },
    { label: "Email", value: contact.email },
    { label: "Company", value: contact.company_name },
  ];
  const hasAnyInfo = infoFields.some((field) => field.value);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Link
        href="/contacts"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Contacts
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-semibold text-white">
            {contactInitials(contact)}
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{name}</h1>
            {contact.company_name ? <p className="text-sm text-slate-500">{contact.company_name}</p> : null}
          </div>
        </div>
        <ContactActions contact={contact} />
      </div>

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>Contact Information</h2>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
          {hasAnyInfo ? (
            infoFields
              .filter((field) => field.value)
              .map((field) => (
                <div key={field.label}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{field.label}</dt>
                  <dd className="mt-1 text-sm text-slate-900">{field.value}</dd>
                </div>
              ))
          ) : (
            <p className="text-sm text-slate-500 sm:col-span-2">No contact details provided yet.</p>
          )}
        </dl>
      </div>

      {contact.notes ? (
        <div className={cardClass}>
          <div className={cardHeaderClass}>
            <h2 className={cardTitleClass}>Notes</h2>
          </div>
          <p className="whitespace-pre-wrap px-5 py-5 text-sm text-slate-700">{contact.notes}</p>
        </div>
      ) : null}

      <div className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 className={cardTitleClass}>Activity</h2>
        </div>
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-slate-500">
            Leads, appointments, conversations, and other activity for this contact will appear
            here in a future update.
          </p>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Added {formatContactDate(contact.created_at)}
        {contact.updated_at !== contact.created_at
          ? ` · Updated ${formatContactDate(contact.updated_at)}`
          : ""}
      </p>
    </div>
  );
}
