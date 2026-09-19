import Link from "next/link";
import { Hammer } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { primaryButtonAutoClass } from "@/lib/ui/form";

/**
 * Unlike Leads/Estimates, there is no "Add Job" action here - jobs are only
 * ever created by accepting an estimate (lib/automation/jobs.ts's
 * emitJobCreatedFromEstimate, the sole job-creation path per explicit
 * decision). The empty state explains that workflow instead of offering a
 * button to a feature that doesn't exist.
 */
export function JobsEmptyState() {
  return (
    <EmptyState
      icon={Hammer}
      title="No jobs yet."
      description="Jobs are created automatically when a customer accepts an estimate. Once that happens, it'll show up here ready to schedule."
      action={
        <Link href="/estimates" className={primaryButtonAutoClass}>
          Go to Estimates
        </Link>
      }
    />
  );
}
