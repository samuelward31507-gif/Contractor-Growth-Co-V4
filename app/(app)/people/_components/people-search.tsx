"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import type { PersonSort } from "../page";

const SORT_OPTIONS: { value: PersonSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name_asc", label: "Name (A–Z)" },
];

/** Adapted 1:1 from contacts-search.tsx - same debounced-URL-param pattern, just pointed at PersonSort/the /people route instead of ContactSort/../contacts. */
export function PeopleSearch({
  initialQuery,
  initialSort,
}: {
  initialQuery: string;
  initialSort: PersonSort;
}) {
  const [value, setValue] = useState(initialQuery);
  const [sort, setSort] = useState<PersonSort>(initialSort);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextSort: PersonSort) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextSort !== "newest") params.set("sort", nextSort);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(value, sort), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleSortChange(next: PersonSort) {
    setSort(next);
    navigate(value, next);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search by name, phone, email, or company"
          aria-label="Search people"
          className={`${inputClass} pl-9`}
        />
        {value ? (
          <button
            type="button"
            onClick={() => setValue("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <select
        value={sort}
        onChange={(event) => handleSortChange(event.target.value as PersonSort)}
        aria-label="Sort people"
        className={`${inputClass} sm:w-44`}
      >
        {SORT_OPTIONS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
}
