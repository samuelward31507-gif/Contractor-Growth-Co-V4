import type { LeadTemperature } from "@/lib/leads/queries";

/**
 * Final Batch 3: which people a People view shows. Pure - it only selects
 * from the list it is given and never changes a row.
 *
 *   view "leads"            everyone with an OPEN lead, whatever its
 *                           temperature (hot, warm and cold) - the Leads view.
 *   temperature hot/warm/cold  narrows to people whose most recent open lead
 *                           has that temperature (with or without the view;
 *                           Today's "N hot" link keeps working).
 *   neither                 everyone.
 *
 * `temperatureByContactId` holds an entry exactly for the people with an
 * open lead (its value is that lead's temperature), so "has an open lead" is
 * read from the same map the temperature filter uses.
 */
export type PeopleView = "all" | "leads";

export function filterPeople<T extends { id: string }>(
  contacts: readonly T[],
  temperatureByContactId: ReadonlyMap<string, LeadTemperature>,
  filters: { view: PeopleView; temperature: LeadTemperature | "all" },
): T[] {
  return contacts.filter((contact) => {
    const temperature = temperatureByContactId.get(contact.id);
    if (filters.view === "leads" && temperature === undefined) return false;
    if (filters.temperature !== "all" && temperature !== filters.temperature) return false;
    return true;
  });
}
