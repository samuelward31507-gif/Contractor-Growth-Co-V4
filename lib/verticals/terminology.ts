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
  // Trackpr 2.0, Phase 1: "Contacts" retired as the contractor-facing nav
  // label in favor of "Customers" (the locked Trackpr 2.0 umbrella noun -
  // see the Master Product Specification's own Part 4/7) - the underlying
  // field name (contactsLabel) is unchanged, since nothing outside
  // nav-items.ts reads it (verified directly - this dictionary has exactly
  // one consumer).
  contractor: { contactsLabel: "Customers", contactSingular: "contact" },
  gym: { contactsLabel: "Members", contactSingular: "member" },
};

export function getTerminology(vertical: OrganizationVertical): VerticalTerminology {
  return TERMINOLOGY[vertical];
}
