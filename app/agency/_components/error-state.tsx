import { AlertCircle } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";

/**
 * Deliberately generic - never passed a raw error message, database error,
 * or stack trace. The page catches any thrown error server-side and renders
 * this instead of letting Next.js's default error boundary (or worse, a
 * leaked internal detail) reach the browser.
 */
export function ErrorState() {
  return (
    <EmptyState
      icon={AlertCircle}
      title="The Command Center couldn't load right now."
      description="Please try again shortly."
    />
  );
}
