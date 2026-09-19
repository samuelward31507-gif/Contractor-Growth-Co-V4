/** Same skeleton convention as app/(app)/contacts/loading.tsx. */
export default function ContactDuplicatesLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="h-4 w-32 animate-pulse rounded bg-slate-100" />
      <div>
        <div className="h-7 w-48 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-slate-100" />
      </div>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
    </div>
  );
}
