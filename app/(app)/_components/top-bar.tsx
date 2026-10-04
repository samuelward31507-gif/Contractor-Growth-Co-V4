import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { CommandMenuTrigger } from "@/lib/ui/command-menu";
import { Breadcrumb, MobilePageTitle } from "./breadcrumb";
import { BrandMark } from "./sidebar-content";
import { SystemStatus } from "./system-status";
import { describeSystemStatus } from "./system-status-model";

/**
 * Trackpr 2.0 (step 2D): the one header above page content, on every screen
 * size - light, 48px, aligned with the sidebar's own header row so the two
 * read as one hairline across the shell.
 *
 *   Desktop (lg+): where you are (Breadcrumb) on the left; system status on
 *   the right. The sidebar already carries the brand and workspace.
 *   Mobile/tablet: the brand mark with the current page and workspace on the
 *   left, status on the right - this replaces the separate mobile brand bar,
 *   so there is exactly one header above the content (the 2C bottom tab bar
 *   stays below it).
 *
 * Status reuses lib/automation-health/health.ts's getOrganizationHealth - a
 * request-cached read the shell already paid for (never a new query path) -
 * and fails silently to no indicator (never a broken page) if it errors.
 * No global search box: no record search index exists, so a search field
 * would be fake functionality. Theme upgrade: the right side carries a
 * visible trigger for the existing Cmd/Ctrl+K command menu
 * (lib/ui/command-menu.tsx) - it opens the same palette, never a search
 * of its own.
 *
 * `actions` is an optional right-side slot for a page's own contextual
 * controls - nothing passes it yet.
 */
export async function TopBar({
  supabase,
  organizationId,
  organizationName,
  actions,
}: {
  supabase: SupabaseClient;
  organizationId: string;
  organizationName: string;
  actions?: ReactNode;
}) {
  const health = await getOrganizationHealth(supabase, organizationId).catch(() => null);
  const status = health ? describeSystemStatus(health) : null;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface pl-4 pr-2 sm:pr-4 lg:px-10">
      <div className="flex min-w-0 items-center gap-2.5 lg:hidden">
        <BrandMark />
        <div className="min-w-0 leading-tight">
          <MobilePageTitle />
          <p className="truncate text-[11.5px] text-ink-3">{organizationName}</p>
        </div>
      </div>
      <div className="hidden min-w-0 lg:block">
        <Breadcrumb />
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        {actions}
        <CommandMenuTrigger />
        {status ? <SystemStatus view={status} /> : null}
      </div>
    </header>
  );
}
