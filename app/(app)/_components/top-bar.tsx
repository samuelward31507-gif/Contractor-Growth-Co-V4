import Link from "next/link";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import type { OrganizationHealthStatus } from "@/lib/automation-health/types";
import { Breadcrumb } from "./breadcrumb";

/**
 * Pass 5A: widened to the full OrganizationHealthStatus union (paused and
 * payment_blocked joined the original 3) so this indicator can never
 * misreport an intentional pause or a payment block as a random
 * infrastructure issue - see lib/automation-health/health.ts's own
 * organizationStatus() for the precedence rule this mirrors.
 */
const STATUS_CONFIG: Record<OrganizationHealthStatus, { dot: string; label: string; ring: string; text: string }> = {
  healthy: { dot: "bg-emerald-500", label: "All systems healthy", ring: "ring-accent-border hover:bg-accent-muted", text: "text-accent-text" },
  degraded: { dot: "bg-amber-500", label: "Needs attention", ring: "ring-amber-200 hover:bg-amber-50", text: "text-amber-700" },
  unhealthy: { dot: "bg-red-500", label: "Critical issue", ring: "ring-red-200 hover:bg-red-50", text: "text-red-700" },
  paused: { dot: "bg-slate-400", label: "Automation paused", ring: "ring-slate-200 hover:bg-slate-50", text: "text-slate-600" },
  payment_blocked: { dot: "bg-red-500", label: "Payment action needed", ring: "ring-red-200 hover:bg-red-50", text: "text-red-700" },
};

/**
 * The persistent top bar - present above page content on every screen size,
 * answering "where am I" (Breadcrumb) and "are my automations working"
 * (the one health signal the product brief specifically calls out for the
 * global shell) without repeating what each page's own header already
 * says. Deliberately does not duplicate the sidebar's own org/user/logout
 * block, and deliberately has no "global search" - no search index exists
 * anywhere in this app today, and a search box that searches nothing would
 * be exactly the fake functionality the redesign brief prohibits.
 *
 * Reuses lib/automation-health/health.ts's existing, already-bounded
 * getOrganizationHealth (3 parallel indexed queries, the same ones the
 * Automation Health page itself already pays on every load) - never a new
 * query path. Fails silently to no indicator (never a broken page) if the
 * health read errors for any reason.
 *
 * Trackpr 2.0, Phase 3A: `actions` is a new, optional right-side slot for a
 * future page's own contextual controls (e.g. a page-level primary action
 * that should live in the persistent top bar rather than scroll away with
 * page content) - foundation only, nothing passes it yet, so it renders
 * nothing and changes no existing page's appearance until a future phase
 * actually uses it.
 */
export async function TopBar({ supabase, organizationId, actions }: { supabase: SupabaseClient; organizationId: string; actions?: ReactNode }) {
  const health = await getOrganizationHealth(supabase, organizationId).catch(() => null);
  const status = health ? STATUS_CONFIG[health.status] : null;

  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-10">
      <Breadcrumb />
      <div className="flex shrink-0 items-center gap-3">
        {actions}
        {status ? (
          <Link
            href="/automation-health"
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/25 focus-visible:ring-offset-2 ${status.ring} ${status.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden />
            {status.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
