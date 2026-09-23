import { surfaceClass } from "@/lib/ui/surface";

export function ActivityEmptyState() {
  return (
    <div className={`${surfaceClass} flex flex-1 items-center justify-center px-6 py-20`}>
      <div className="max-w-sm text-center">
        <h2 className="text-base font-medium text-slate-900">No activity yet.</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Activity will appear here as you and your team use Trackpr - things like new contacts, lead updates, and
          appointment changes.
        </p>
      </div>
    </div>
  );
}
