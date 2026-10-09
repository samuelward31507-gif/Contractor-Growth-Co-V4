import type { ReactNode } from "react";
import { BrandMark } from "@/app/(app)/_components/sidebar-content";
import { OperatorMobileMenu } from "./operator-mobile-menu";
import { OperatorBreadcrumb, OperatorNavContent, OperatorPageTitle } from "./operator-nav-content";
import type { OperatorNavGroup } from "./nav";

/**
 * The shell for Trackpr's operator areas (the Agency Command Center and the
 * Founder Command Center): the same structure as the client app's shell
 * (app/(app)/layout.tsx) - the dark desktop sidebar, one header above the
 * content (the workspace gray at lg+, white on mobile with the brand, page
 * title and a menu), and one scrolling <main>. It carries no data beyond the
 * signed-in email and the nav groups the layout resolved from verified
 * access, so it is safe to render for any signed-in user; every page checks
 * its own authorization.
 */
export function OperatorShell({
  title,
  groups,
  userEmail,
  roleLabel,
  children,
}: {
  title: string;
  groups: OperatorNavGroup[];
  userEmail: string;
  roleLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        Skip to content
      </a>
      <aside aria-label={`${title} navigation`} className="hidden w-60 shrink-0 bg-sidebar text-on-dark lg:flex">
        <OperatorNavContent title={title} groups={groups} userEmail={userEmail} roleLabel={roleLabel} surface="dark" />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface pl-4 pr-1.5 lg:h-14 lg:border-line/80 lg:bg-canvas lg:px-10">
          <div className="flex min-w-0 items-center gap-2.5 lg:hidden">
            <BrandMark />
            <div className="min-w-0 leading-tight">
              <OperatorPageTitle groups={groups} fallback={title} className="truncate text-[13px] font-semibold text-ink" />
              <p className="truncate text-[11.5px] text-ink-3">{title}</p>
            </div>
          </div>
          <div className="hidden min-w-0 lg:block">
            <OperatorBreadcrumb title={title} groups={groups} />
          </div>
          <OperatorMobileMenu title={title} groups={groups} userEmail={userEmail} roleLabel={roleLabel} />
        </header>
        <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
