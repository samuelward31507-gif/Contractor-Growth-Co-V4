import { Inbox } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
        <Inbox className="h-5 w-5 text-slate-400" aria-hidden />
      </span>
      <p className="mt-4 text-sm font-medium text-slate-900">No client organizations are currently connected.</p>
      <p className="mt-1 text-sm text-slate-500">Once a client organization is associated with the agency, it will appear here.</p>
    </div>
  );
}
