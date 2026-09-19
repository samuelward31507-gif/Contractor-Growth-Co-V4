import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { Breadcrumb } from "./breadcrumb";

const STATUS_CONFIG: Record<"healthy" | "degraded" | "unhealthy", { dot: string; label: string }> = {
  healthy: { dot: "bg-emerald-500", label: "All systems healthy" },
  degraded: { dot: "bg-amber-500", label: "Needs attention" },
  unhealthy: { dot: "bg-red-500", label: "Critical issue" },
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
 */
export async function TopBar({ supabase, organizationId }: { supabase: SupabaseClient; organizationId: string }) {
  const health = await getOrganizationHealth(supabase, organizationId).catch(() => null);
  const status = health ? STATUS_CONFIG[health.status] : null;

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-10">
      <Breadcrumb />
      {status ? (
        <Link
          href="/automation-health"
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden />
          {status.label}
        </Link>
      ) : null}
    </div>
  );
}
