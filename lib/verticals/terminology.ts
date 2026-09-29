import type { OrganizationVertical } from "@/lib/auth/organization";

export type VerticalTerminology = {
  contactsLabel: string;
  contactSingular: string;
};

/**
 * Gym Foundation Phase 1, Section 5: the smallest reusable mechanism for
 * vertical-aware terminology. Application-level only - no database table or
 * contractor concept is renamed. Deliberately small: only "contacts" has a
 * gym-specific name today (members), because that's the one place Phase 1
 * actually wires this up (the nav sidebar label, see
 * app/(app)/_components/nav-items.ts). This is not a broad copy/relabeling
 * system - a later phase that needs more terms extends this dictionary,
 * it doesn't need a new mechanism.
 */
const TERMINOLOGY: Record<OrganizationVertical, VerticalTerminology> = {
  // Trackpr 2.0 (step 2C): the /people list is labelled "Contacts" in
  // navigation, under the new Customers group (Leads sits beside it as the
  // hot-lead view of the same list). Nothing outside nav-items.ts reads
  // contactsLabel (verified directly - this dictionary has exactly one
  // consumer), so this is a navigation label change only.
  contractor: { contactsLabel: "Contacts", contactSingular: "contact" },
  gym: { contactsLabel: "Members", contactSingular: "member" },
};

export function getTerminology(vertical: OrganizationVertical): VerticalTerminology {
  return TERMINOLOGY[vertical];
}
