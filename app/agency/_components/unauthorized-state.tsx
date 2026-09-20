import { Lock } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";

/**
 * Shown for any signed-in user who is not a recognized agency admin, or who
 * isn't signed in at all if this somehow renders before the layout's
 * redirect. Never renders organization data, counts, or names - the caller
 * must not pass any agency data into this component in the first place.
 */
export function UnauthorizedState() {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access to the Agency Command Center."
      description="This area is restricted to Contractor Growth Co. agency administrators."
    />
  );
}
