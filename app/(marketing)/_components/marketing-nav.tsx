"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Container } from "./section";
import { CtaLink } from "./cta-button";

const NAV_LINKS = [
  { href: "/how-it-works", label: "How It Works" },
  { href: "/services", label: "Services" },
  { href: "/#trackpr", label: "Trackpr" },
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);

  // Escape-to-close, the same pattern as lib/ui/dialog.tsx's Dialog
  // primitive - kept local here since this is a slide-in drawer (not a
  // centered modal) with its own distinct markup. Closing on navigation
  // happens directly in each link's onClick below rather than in an effect,
  // so there's no synchronous setState-in-effect on every route change.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <Fragment>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <Container className="flex h-16 items-center justify-between sm:h-[72px]">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-white">
              C
            </span>
            Contractor Growth Co.
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-8 lg:flex">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900">
                {link.label}
              </Link>
            ))}
            <Link href="/login" className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900">
              Login
            </Link>
          </nav>

          <div className="hidden lg:block">
            <CtaLink href="/get-started" className="!px-5 !py-2.5 !text-sm">
              Get Started
            </CtaLink>
          </div>

          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100 lg:hidden"
            onClick={() => setOpen(true)}
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </Container>
      </header>

      {/* Rendered as a sibling of <header>, not nested inside it - a
          position:fixed element nested inside a position:sticky ancestor
          gets that ancestor as its containing block in this browser (the
          drawer collapsed to the header's own ~64px height instead of the
          viewport), rather than being fixed to the viewport as intended.
          Always mounted (not conditionally rendered) so the open/close
          transitions have something to animate between; prefers-reduced-motion
          collapses both to an instant toggle via motion-reduce:transition-none. */}
      <div className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={open ? 0 : -1}
          className={`absolute inset-0 bg-slate-950/50 transition-opacity duration-300 motion-reduce:transition-none ${
            open ? "opacity-100" : "opacity-0"
          }`}
          onClick={() => setOpen(false)}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
          className={`absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-white px-7 py-6 shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold tracking-tight text-slate-900">Contractor Growth Co.</span>
            <button
              type="button"
              aria-label="Close menu"
              tabIndex={open ? 0 : -1}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100"
              onClick={() => setOpen(false)}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>

          <nav aria-label="Mobile" className="mt-10 flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                tabIndex={open ? 0 : -1}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3.5 text-[17px] font-medium text-slate-800 transition-colors hover:bg-slate-50"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/login"
              tabIndex={open ? 0 : -1}
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-3.5 text-[17px] font-medium text-slate-800 transition-colors hover:bg-slate-50"
            >
              Login
            </Link>
          </nav>

          <div className="mt-auto pt-8">
            <CtaLink href="/get-started" className="w-full justify-center" onClick={() => setOpen(false)} tabIndex={open ? 0 : -1}>
              Get Started
            </CtaLink>
          </div>
        </div>
      </div>
    </Fragment>
  );
}
