"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icon";
import type { NavItem } from "./nav-items";

export function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 rounded-md border-l-2 px-3 py-1.5 text-sm transition-colors duration-150 ${
        isActive
          ? "border-slate-900 bg-slate-200 font-semibold text-slate-900"
          : "border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      <Icon
        name={item.icon}
        className={`h-[18px] w-[18px] shrink-0 ${
          isActive ? "text-slate-900" : "text-slate-400"
        }`}
      />
      <span>{item.label}</span>
    </Link>
  );
}
