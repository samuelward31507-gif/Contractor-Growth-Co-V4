"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hasSearchChanged } from "@/lib/ui/search-sync";
import { Search } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import { INVOICE_STATUS_OPTIONS } from "./status";

/** Search + status filter for the invoices list, the EstimatesToolbar pattern with "Overdue" as a derived pseudo-status. */
export function InvoicesToolbar({ initialQuery, initialStatus, extraParams }: { initialQuery: string; initialStatus: string; extraParams?: Record<string, string> }) {
  const [query, setQuery] = useState(initialQuery);
  // The search text currently reflected in the URL - see lib/ui/search-sync.ts.
  const lastSyncedQuery = useRef(initialQuery.trim());
  const [status, setStatus] = useState(initialStatus);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextStatus: string) {
    lastSyncedQuery.current = nextQuery.trim();
    const params = new URLSearchParams(extraParams);
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextStatus !== "all") params.set("status", nextStatus);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    if (!hasSearchChanged(query, lastSyncedQuery.current)) return;
    const handle = setTimeout(() => navigate(query, status), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  function clearAll() {
    lastSyncedQuery.current = "";
    setQuery("");
    setStatus("all");
    const params = new URLSearchParams(extraParams);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by number, title, customer…" aria-label="Search invoices" className={`${inputClass} pl-9`} />
      </div>

      <select value={status} onChange={(event) => handleStatusChange(event.target.value)} aria-label="Filter by status" className={`${inputClass} sm:w-44`}>
        <option value="all">All statuses</option>
        <option value="overdue">Overdue</option>
        {INVOICE_STATUS_OPTIONS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      {hasActiveFilters ? (
        <button type="button" onClick={clearAll} className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
