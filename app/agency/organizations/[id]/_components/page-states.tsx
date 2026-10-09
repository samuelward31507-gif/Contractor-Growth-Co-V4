import Link from "next/link";
import type { ReactNode } from "react";
import { AlertCircle, SearchX } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { secondaryButtonAutoClass } from "@/lib/ui/form";

/** The standard page container for the full-page states below, so a state never sits in a different column than the page it replaces. */
export function StatePage({ children }: { children: ReactNode }) {
  return <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>{children}</div>;
}

function BackToAgency() {
  return (
    <Link href="/agency" className={secondaryButtonAutoClass}>
      Back to Agency Command Center
    </Link>
  );
}

/**
 * The organization id is not one of this agency's own resolved clients.
 * Worded so the response is identical whether the organization does not
 * exist or simply is not this agency's - it never confirms or denies that
 * an organization exists. Renders no organization data.
 */
export function ClientUnavailableState() {
  return (
    <EmptyState
      icon={SearchX}
      title="This client isn't available."
      description="It may not exist, or it isn't one of the clients your agency manages. Check the link, or open the client from the Command Center."
      action={<BackToAgency />}
    />
  );
}

/**
 * A read threw while loading this client. Deliberately generic - never
 * passed a raw error message, database error, or stack trace.
 */
export function ClientLoadErrorState() {
  return (
    <EmptyState
      icon={AlertCircle}
      title="This client couldn't load right now."
      description="Nothing was changed. Reload the page in a moment, or go back to the Command Center."
      action={<BackToAgency />}
    />
  );
}
