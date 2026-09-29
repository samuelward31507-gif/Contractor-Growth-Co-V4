/**
 * Performance Pass A: the rule behind every list toolbar's debounced
 * "search box -> URL" sync (people, contacts, leads, jobs, estimates,
 * appointments, invoices, Insights activity, Agency).
 *
 * Each toolbar keeps its typed text in local state and writes it to the URL
 * (router.replace) 300ms after typing stops. That effect is keyed on the
 * text, so React also runs it once on mount - with the exact text the page
 * was just rendered from - and the resulting router.replace to an unchanged
 * URL made Next.js render the whole page on the server a second time on
 * every visit. A toolbar now remembers the last search text it synced to
 * the URL (starting with the text the page rendered with) and navigates
 * only when the text really differs. Filters, sort and clear still navigate
 * immediately, exactly as before; they update the remembered value too.
 */
export function hasSearchChanged(nextValue: string, lastSynced: string): boolean {
  return nextValue.trim() !== lastSynced.trim();
}
