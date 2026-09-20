import { LogOut } from "lucide-react";
import { NAV_GROUPS, AGENCY_NAV_ITEM } from "./nav-items";
import { NavLink } from "./nav-link";
import { logout } from "../actions";

/**
 * Trackpr visual-system redesign: the sidebar now carries the marketing
 * site's actual visual signature - not just a dark fill, but the same soft
 * radial emerald glow the Contractor Growth Co. homepage hero uses (see
 * app/(marketing)/_components/home/hero.tsx) - so opening the app reads as
 * a continuation of the same surface, not a different product that happens
 * to share a color. The brand lockup below
 * mirrors the marketing nav's "C" mark + wordmark pairing, plus the site's
 * own eyebrow typography ("CONTRACTOR GROWTH CO.", uppercase, wide
 * tracking, emerald). The organization name gets its own distinct
 * workspace chip beneath that - real account context, not folded into the
 * brand lockup itself.
 */
export function SidebarContent({
  organizationName,
  userEmail,
  role,
  showAgencyLink,
  onNavigate,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  /** Only ever true for a session-verified agency admin (see layout.tsx) - a hidden link is a UX convenience, never the actual authorization boundary, which /agency and its data reads enforce independently on every request. */
  showAgencyLink: boolean;
  onNavigate?: () => void;
}) {
  const groups = showAgencyLink ? [...NAV_GROUPS, { label: "Agency", items: [AGENCY_NAV_ITEM] }] : NAV_GROUPS;

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
        <p className="truncate text-xs font-medium text-slate-300">{organizationName}</p>
      </div>

      <nav className="relative flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`}>
            {group.label ? (
              <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">{group.label}</p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="relative border-t border-white/[0.07] p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
            {userEmail.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{userEmail}</p>
            <p className="text-xs capitalize text-slate-500">{role}</p>
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
