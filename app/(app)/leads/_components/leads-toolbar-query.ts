import type { LeadSort } from "../page";

/**
 * Pure URL-building logic behind LeadsToolbar's debounced router.replace().
 * Kept in its own plain .ts file (no JSX) so it can be unit tested directly
 * under plain `node:test` - this repo has no jsdom/React Testing Library,
 * and Node's native TypeScript support cannot parse JSX, so a function
 * living inside leads-toolbar.tsx itself is not importable from a test file.
 *
 * `from` is the /customers dispatcher's page-identity marker (see
 * app/(app)/customers/page.tsx - `from=lead` is what routes a request to
 * LeadsPage instead of ContactsPage). It is set once from the server and is
 * never itself user-editable, so unlike q/status/temperature it MUST survive
 * every rebuild here and is never cleared by LeadsToolbar's clearAll() - if
 * it is dropped, the next replace() silently falls back to the unfiltered
 * Customers list. This was the exact cause of the Active/Hot/Qualified Leads
 * filter-persistence bug.
 */
export function buildLeadsQueryString(params: {
  from?: string;
  query: string;
  status: string;
  temperature: string;
  sort: LeadSort;
}): string {
  const searchParams = new URLSearchParams();
  if (params.from) searchParams.set("from", params.from);
  const trimmed = params.query.trim();
  if (trimmed) searchParams.set("q", trimmed);
  if (params.status !== "all") searchParams.set("status", params.status);
  if (params.temperature !== "all") searchParams.set("temperature", params.temperature);
  if (params.sort !== "newest") searchParams.set("sort", params.sort);
  return searchParams.toString();
}
