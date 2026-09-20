import Link from "next/link";
import { ArrowLeft, LayoutDashboard, LogOut } from "lucide-react";
import { logout } from "@/app/(app)/actions";

/**
 * Agency Command Center UI review: the Agency shell previously had no
 * sidebar at all (app/agency/layout.tsx rendered bare white content), so
 * navigating here from the client CRM's own "Agency Command Center" nav
 * link dropped the visual shell entirely. This mirrors
 * app/(app)/_components/sidebar-content.tsx's exact dark-surface language
 * (same bg, same radial glow, same brand lockup, same nav-link active/hover
 * treatment, same account footer) - it is not a new visual system, just the
 * same one used for an internal-operator context instead of a client
 * workspace. Agency navigation is deliberately a single "Overview" item:
 * today there is exactly one real Agency destination (client detail pages
 * are a drill-down from the client list, never a sidebar destination). The
 * "Back to Trackpr" link above it is a real, explicit route to /dashboard
 * (not browser back) - an agency admin reaching this shell from the client
 * CRM's own nav link needs an equally explicit way back, and it is styled
 * as a muted secondary action (matching the footer's own Log out hover
 * treatment) precisely so it never competes with the Overview destination
 * for visual weight.
 */
export function AgencySidebarContent({
  userEmail,
  isAdmin,
  onNavigate,
}: {
  userEmail: string;
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#0a120f]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_-15%,rgba(16,185,129,0.10),transparent)]"
      />

      <div className="relative flex items-center gap-2.5 px-5 pb-4 pt-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-sm font-bold text-slate-950">
          T
        </span>
        <div className="min-w-0">
          <span className="block text-[15px] font-semibold leading-tight tracking-tight text-white">Trackpr</span>
          <p className="truncate text-[9.5px] font-semibold uppercase tracking-[0.16em] text-emerald-400/80">
            Contractor Growth Co.
          </p>
        </div>
      </div>

      <div className="relative mx-4 mb-3 flex items-center gap-2 truncate rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-inset ring-white/[0.07]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
        <p className="truncate text-xs font-medium text-slate-300">Agency Command Center</p>
      </div>

      <nav className="relative flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          <Link
            href="/dashboard"
            onClick={onNavigate}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            <ArrowLeft className="h-[18px] w-[18px] shrink-0 text-slate-500" aria-hidden />
            <span className="truncate">Back to Trackpr</span>
          </Link>
        </div>

        <div className="space-y-0.5">
          <Link
            href="/agency"
            onClick={onNavigate}
            aria-current="page"
            className="flex w-full items-center gap-3 rounded-lg bg-emerald-500/[0.14] px-3 py-2 text-[13.5px] font-semibold text-white ring-1 ring-inset ring-emerald-500/25"
          >
            <LayoutDashboard className="h-[18px] w-[18px] shrink-0 text-emerald-400" aria-hidden />
            <span className="truncate">Overview</span>
          </Link>
        </div>
      </nav>

      <div className="relative border-t border-white/[0.07] p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
            {userEmail.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{userEmail}</p>
            <p className="text-xs text-slate-500">{isAdmin ? "Agency admin" : "Not an agency admin"}</p>
          </div>
        </div>
        <form action={logout} className="mt-1">
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0 text-slate-500" aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
