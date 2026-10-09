"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, LogOut } from "lucide-react";
import { logout } from "@/app/(app)/actions";
import { BrandMark } from "@/app/(app)/_components/sidebar-content";
import { OPERATOR_ICONS } from "./icons";
import { resolveOperatorActiveItem, type OperatorNavGroup } from "./nav";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The operator areas' navigation, in the client app's final shell language
 * (app/(app)/_components/sidebar-content.tsx + nav-link.tsx): on desktop the
 * deep pine-ink sidebar with light rows and the restrained active chip; in
 * the mobile drawer (`surface="light"`) the white sheet with 44px touch rows.
 * Which groups appear is decided by the server layout from verified access -
 * hiding a link is never the authorization boundary; every page and data
 * read re-checks access on its own.
 */
export function OperatorNavContent({
  title,
  groups,
  userEmail,
  roleLabel,
  surface,
  onNavigate,
}: {
  title: string;
  groups: OperatorNavGroup[];
  userEmail: string;
  roleLabel: string;
  surface: "dark" | "light";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = resolveOperatorActiveItem(groups, pathname);
  const dark = surface === "dark";
  const row = `group/nav flex w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 ${dark ? "h-8" : "min-h-11 text-sm"} ${FOCUS_RING}`;
  const idle = dark ? "text-on-dark-2 hover:bg-dark-fill hover:text-on-dark" : "text-ink-2 hover:bg-hover hover:text-ink";
  const activeRow = dark ? "bg-dark-fill-strong text-on-dark inset-ring inset-ring-dark-line" : "bg-selected text-ink";
  const iconIdle = dark ? "text-on-dark-3 group-hover/nav:text-on-dark-2" : "text-ink-3 group-hover/nav:text-ink-2";
  const iconActive = dark ? "text-accent-on-dark" : "text-accent";
  const line = dark ? "border-dark-line" : "border-line";

  return (
    <div className="flex h-full w-full flex-col">
      {dark ? (
        <div className={`flex h-14 shrink-0 items-center gap-3 border-b ${line} px-4`}>
          <BrandMark />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[15px] font-semibold tracking-[-0.01em] text-on-dark">Trackpr</p>
            <p className="mt-0.5 truncate text-[11.5px] text-on-dark-3">{title}</p>
          </div>
        </div>
      ) : null}

      <nav aria-label={title} className="flex-1 overflow-y-auto px-2 py-3">
        <Link href="/today" onClick={onNavigate} className={`${row} ${idle}`}>
          <ArrowLeft className={`h-4 w-4 shrink-0 ${iconIdle}`} strokeWidth={1.75} aria-hidden />
          <span className="truncate">Back to Trackpr</span>
        </Link>

        {groups.map((group) => (
          <div key={group.id} className="mt-4" role="group" aria-labelledby={`operator-group-${surface}-${group.id}`}>
            <p id={`operator-group-${surface}-${group.id}`} className={`mb-1 px-2.5 text-[11.5px] font-medium ${dark ? "text-on-dark-3" : "text-ink-3"}`}>
              {group.label}
            </p>
            <div className="space-y-px">
              {group.items.map((item) => {
                const Icon = OPERATOR_ICONS[item.icon];
                const isActive = item === active;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={`${row} ${isActive ? activeRow : idle}`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${isActive ? iconActive : iconIdle}`} strokeWidth={1.75} aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={`border-t ${line} px-2 py-2`}>
        <div className="flex items-center gap-2.5 px-2.5 py-1.5">
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${dark ? "bg-dark-fill-strong text-on-dark-2 inset-ring inset-ring-dark-line" : "bg-inset text-ink-2"}`}
          >
            {userEmail.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className={`truncate text-[13px] font-medium ${dark ? "text-on-dark" : "text-ink"}`} title={userEmail}>
              {userEmail}
            </p>
            <p className={`text-[11.5px] ${dark ? "text-on-dark-3" : "text-ink-3"}`}>{roleLabel}</p>
          </div>
        </div>
        <form action={logout}>
          <button type="submit" className={`${row} ${idle}`}>
            <LogOut className={`h-4 w-4 shrink-0 ${iconIdle}`} strokeWidth={1.75} aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}

/** The current page's label, for the top bar - the same resolver the nav uses. */
export function OperatorPageTitle({ groups, fallback, className }: { groups: OperatorNavGroup[]; fallback: string; className: string }) {
  const pathname = usePathname();
  const active = resolveOperatorActiveItem(groups, pathname);
  return <p className={className}>{active?.label ?? fallback}</p>;
}

/** Desktop "Area / Page" trail; just the area when the path matches no nav item. */
export function OperatorBreadcrumb({ title, groups }: { title: string; groups: OperatorNavGroup[] }) {
  const pathname = usePathname();
  const active = resolveOperatorActiveItem(groups, pathname);
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className={active ? "text-ink-3" : "font-medium text-ink"}>{title}</span>
      {active ? (
        <>
          <span aria-hidden className="text-ink-4">/</span>
          <span className="truncate font-medium text-ink">{active.label}</span>
        </>
      ) : null}
    </p>
  );
}
