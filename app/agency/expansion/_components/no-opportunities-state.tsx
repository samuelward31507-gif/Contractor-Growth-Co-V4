import { Search } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";

/**
 * A genuine empty state, not an error - rendered only when
 * getAgencyExpansionOpportunities succeeded and returned zero open
 * opportunities across every authorized client. Mirrors
 * app/agency/_components/error-state.tsx / unauthorized-state.tsx's own
 * pattern of a small named wrapper around the shared EmptyState primitive.
 */
export function NoOpportunitiesState() {
  return (
    <EmptyState
      icon={Search}
      title="No expansion opportunities detected"
      description="Trackpr isn't currently seeing actionable expansion signals across your managed clients."
    />
  );
}
