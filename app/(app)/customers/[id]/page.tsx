import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getLead } from "@/lib/leads/queries";

/**
 * IA consolidation pass: /customers/[id] no longer renders LeadDetailPage
 * or ContactDetailPage - both were superseded by /people/[id] (Phase 3's
 * unified detail page, verified field-by-field against both of these at the
 * time). This is now a redirect, not a dispatcher - LeadDetailPage/
 * ContactDetailPage and their own _components stay in the repository
 * unmodified (several of their pieces - ContactActions, the lead status/
 * temperature tone maps - are still live imports of /people/[id] itself),
 * they're just no longer reachable through this route.
 *
 * `leads.id` and `contacts.id` are different primary keys of different
 * tables (Lead is a stage on a Customer, never a merged entity) - a bare
 * :id segment from the `from=lead` case cannot be resolved to a /people/:id
 * (a CONTACT id) without a real lookup, which next.config.ts's static
 * redirects cannot perform - hence this one dynamic hop. The `from=contact`
 * case needs no lookup at all: a contact's own id is already the id
 * /people/[id] expects.
 */
export default async function CustomerDetailRedirect(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const from = typeof searchParams.from === "string" ? searchParams.from : undefined;

  if (from === "lead") {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const membership = await getUserOrganization(supabase, user.id);
      if (membership) {
        const lead = await getLead(supabase, membership.organizationId, id);
        if (lead?.contact_id) {
          redirect(`/people/${lead.contact_id}`);
        }
      }
    }
    // No resolvable contact (deleted lead, no org, or unauthenticated - the
    // page-level auth check on /people itself handles login/onboarding
    // redirects properly) - land on the list rather than a broken link.
    redirect("/people");
  }

  redirect(`/people/${id}`);
}
