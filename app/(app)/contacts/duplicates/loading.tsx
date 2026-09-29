import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

/** Same skeleton convention as app/(app)/contacts/loading.tsx. */
export default function ContactDuplicatesLoading() {
  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div className="h-4 w-32 animate-pulse rounded bg-inset" />
      <div>
        <div className="h-7 w-48 animate-pulse rounded bg-inset" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-inset" />
      </div>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-lg bg-inset" />
        ))}
      </div>
    </div>
  );
}
