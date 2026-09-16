import { NAV_ITEMS } from "./nav-items";
import { NavLink } from "./nav-link";
import { logout } from "../actions";
import { Icon } from "./icon";

export function SidebarContent({
  organizationName,
  userEmail,
  role,
  onNavigate,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-5 py-5">
        <span className="text-lg font-semibold tracking-tight text-slate-900">Trackpr</span>
        <p className="mt-0.5 truncate text-sm text-slate-500">{organizationName}</p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="border-t border-slate-200 p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
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
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <Icon name="logout" className="h-5 w-5 shrink-0" />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
