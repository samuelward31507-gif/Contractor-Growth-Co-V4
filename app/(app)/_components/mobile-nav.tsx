"use client";

import { useState } from "react";
import { Icon } from "./icon";
import { SidebarContent } from "./sidebar-content";

export function MobileNav({
  organizationName,
  userEmail,
  role,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <span className="text-lg font-semibold tracking-tight text-slate-900">Trackpr</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl">
            <div className="flex justify-end px-3 pt-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>
            <div className="h-[calc(100%-3.25rem)]">
              <SidebarContent
                organizationName={organizationName}
                userEmail={userEmail}
                role={role}
                onNavigate={() => setOpen(false)}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
