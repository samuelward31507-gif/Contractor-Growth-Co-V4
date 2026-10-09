import Link from "next/link";
import { AlertCircle, RotateCw } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { secondaryButtonAutoClass } from "@/lib/ui/form";

/**
 * Deliberately generic - never passed a raw error message, database error,
 * or stack trace. The page catches any thrown error server-side and renders
 * this instead of letting Next.js's default error boundary (or worse, a
 * leaked internal detail) reach the browser.
 *
 * `retryHref` (optional) adds a real "Try again" link back to the same page,
 * which re-runs its server render - shown only when the caller passes the
 * page's own path, never a dead button.
 */
export function ErrorState({ retryHref }: { retryHref?: string } = {}) {
  return (
    <EmptyState
      icon={AlertCircle}
      title="The Command Center couldn't load right now."
      description="Agency data couldn't be read just now. Nothing was changed - please try again shortly."
      action={
        retryHref ? (
          <Link href={retryHref} className={secondaryButtonAutoClass}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </Link>
        ) : undefined
      }
    />
  );
}
