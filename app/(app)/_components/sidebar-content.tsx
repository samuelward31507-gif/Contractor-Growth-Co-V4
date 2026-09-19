"use client";

// Release-audit fix: NAV_GROUPS/AGENCY_NAV_ITEM carry a real component
// reference per item (`icon: LucideIcon`), not a plain serializable value.
// Passing that `item` object as a prop from a Server Component into
// NavLink (a Client Component, below) is not allowed by React Server
// Components - it fails at request time with "Only plain objects can be
// passed to Client Components from Server Components," which `next build`
// cannot catch (dynamic routes aren't rendered with real props at build
// time) and which broke every authenticated page's desktop sidebar. This
// file receives only plain, already-resolved primitive props from its
// server parents (organizationName/userEmail/role/showAgencyLink - all
// strings/booleans) and does its own data-free NAV_GROUPS import, so
// marking it "use client" costs nothing (no server-only work happens
// here) and keeps every prop that crosses an actual server/client boundary
// a plain value.

import { LogOut } from "lucide-react";
import { NAV_GROUPS, AGENCY_NAV_ITEM } from "./nav-items";
import { NavLink } from "./nav-link";
import { logout } from "../actions";
import { sectionLabelClass } from "@/lib/ui/typography";

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
    <div className="flex h-full w-full flex-col">
      <div className="px-5 pb-5 pt-6">
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">Trackpr</span>
        <p className="mt-0.5 truncate text-sm text-slate-500">{organizationName}</p>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto pl-4 pr-0 pb-4">
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`}>
            {group.label ? (
              <p className={`mb-1.5 px-3 ${sectionLabelClass}`}>{group.label}</p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            {userEmail.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{userEmail}</p>
            <p className="text-xs capitalize text-slate-500">{role}</p>
          </div>
        </div>
        <form action={logout} className="mt-1">
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0 text-slate-400" aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
