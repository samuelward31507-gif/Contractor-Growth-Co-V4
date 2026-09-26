import LeadDetailPage from "../../leads/[id]/page";
import ContactDetailPage from "../../contacts/[id]/page";

/**
 * Trackpr 2.0, Phase 0: the smallest safe migration target for
 * /customers/[id] (see ../page.tsx's own header comment for the full
 * rationale - identical reasoning applies here). Dispatches, unchanged, to
 * the real LeadDetailPage or ContactDetailPage component.
 *
 * `leads.id` and `contacts.id` are different primary keys of different
 * tables (see the Master Product Specification's own Part 3 - Lead is a
 * stage on a Customer, never a merged entity) - a bare :id segment cannot
 * be resolved to the right table without knowing which one it came from.
 * The `from` marker set by next.config.ts's redirect rules
 * (/leads/:id -> /customers/:id?from=lead,
 * /contacts/:id -> /customers/:id?from=contact) carries exactly that fact
 * through, so this never guesses or performs a lookup against both tables.
 * A direct, un-marked visit falls back to ContactDetailPage, matching the
 * list page's own default.
 */
export default async function CustomerDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const from = typeof params.from === "string" ? params.from : undefined;

  if (from === "lead") {
    return LeadDetailPage(props as Parameters<typeof LeadDetailPage>[0]);
  }
  return ContactDetailPage(props as Parameters<typeof ContactDetailPage>[0]);
}
