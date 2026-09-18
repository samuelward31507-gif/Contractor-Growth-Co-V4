/**
 * Deliberately generic - never passed a raw error message, database error,
 * or stack trace. The page catches any thrown error server-side and renders
 * this instead of letting Next.js's default error boundary (or worse, a
 * leaked internal detail) reach the browser.
 */
export function ErrorState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p className="text-sm font-medium text-slate-900">The Command Center couldn&apos;t load right now.</p>
      <p className="mt-1.5 text-sm text-slate-500">Please try again shortly.</p>
    </div>
  );
}
