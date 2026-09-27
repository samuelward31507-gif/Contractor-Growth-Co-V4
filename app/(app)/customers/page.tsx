import { redirect } from "next/navigation";

/**
 * IA consolidation pass: Customers is no longer its own list - it was a
 * near-exact duplicate of People (same rows, near-identical layout - see
 * the redesign audit's own "Customers vs People" finding). Kept as a
 * redirect, not deleted, so any bookmarked or externally-linked /customers
 * URL (with or without the old `from=lead`/`from=contact` dispatcher
 * marker) keeps working instead of 404ing, matching the established
 * /activity -> /analytics / /automation-health -> /automations pattern.
 * The `from` marker no longer needs branching here - /leads and /contacts
 * themselves now redirect directly to /people (with `from=lead` landing on
 * the hot-leads filter) rather than through this page, so any request that
 * still reaches /customers (from=lead, from=contact, or bare) lands on the
 * one real list either way.
 */
export default function LegacyCustomersRedirect() {
  redirect("/people");
}
