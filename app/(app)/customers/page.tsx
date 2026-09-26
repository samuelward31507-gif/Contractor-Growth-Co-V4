import LeadsPage from "../leads/page";
import ContactsPage from "../contacts/page";

/**
 * Trackpr 2.0, Phase 0 (route strategy + migration safety): the smallest
 * safe migration target for the locked Customers destination
 * (/leads + /contacts -> /customers). This is deliberately NOT the final
 * Trackpr 2.0 Customers page - that real merged experience is Phase 3's
 * job (see the Master Product Specification's own Part 7 and Part 26).
 *
 * Introduces zero new business logic, zero new data fetching, and zero new
 * UI: it dispatches, unchanged, to whichever of the two real, already-built,
 * already-tested page components (LeadsPage/ContactsPage) the request
 * actually came from - both keep their own full auth/org/payment gating,
 * queries, filters, and rendering exactly as they exist today at their own
 * still-fully-functional /leads and /contacts routes.
 *
 * The `from` marker is set explicitly by next.config.ts's own redirect
 * rules (/leads -> /customers?from=lead, /contacts -> /customers?from=contact)
 * - never inferred from any other signal - so this dispatch is deterministic
 * and cannot silently pick the wrong source. A direct, un-marked visit to
 * /customers (no prior /leads or /contacts redirect) falls back to Contacts,
 * the more general of the two underlying concepts, matching the terminology
 * strategy already locked in the Master Product Specification's Part 7
 * ("Customer" is the umbrella noun; Contacts is the broader table).
 */
export default async function CustomersPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const from = typeof params.from === "string" ? params.from : undefined;

  if (from === "lead") {
    return LeadsPage(props as Parameters<typeof LeadsPage>[0]);
  }
  return ContactsPage(props as Parameters<typeof ContactsPage>[0]);
}
