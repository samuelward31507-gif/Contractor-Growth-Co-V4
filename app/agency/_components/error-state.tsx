import { AlertCircle } from "lucide-react";

/**
 * Deliberately generic - never passed a raw error message, database error,
 * or stack trace. The page catches any thrown error server-side and renders
 * this instead of letting Next.js's default error boundary (or worse, a
 * leaked internal detail) reach the browser.
 */
export function ErrorState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
        <AlertCircle className="h-5 w-5 text-slate-400" aria-hidden />
      </span>
      <p className="mt-4 text-sm font-medium text-slate-900">The Command Center couldn&apos;t load right now.</p>
      <p className="mt-1 text-sm text-slate-500">Please try again shortly.</p>
    </div>
  );
}
