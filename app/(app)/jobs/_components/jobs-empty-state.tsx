import Link from "next/link";
import { Hammer } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { AddJobButton } from "./add-job-button";

/**
 * Growth System Completion Pass 1: jobs are still created automatically when
 * a customer accepts an estimate (unchanged), but a contractor can now also
 * create one directly (see AddJobButton) - the empty state offers both.
 */
export function JobsEmptyState({ contacts, leads }: { contacts: Contact[]; leads: Lead[] }) {
  return (
    <EmptyState
      icon={Hammer}
      title="No jobs yet."
      description="Jobs are created automatically when a customer accepts an estimate, or you can create one directly."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <AddJobButton contacts={contacts} leads={leads} />
          <Link href="/work" className={secondaryButtonAutoClass}>
            Go to Estimates
          </Link>
        </div>
      }
    />
  );
}
