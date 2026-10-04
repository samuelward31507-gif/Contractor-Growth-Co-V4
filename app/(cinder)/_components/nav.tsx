"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { CinderLogo } from "./logo";
import { Button } from "./ui";
import { NAV_LINKS, TRACKPR_HREF } from "./content";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

/**
 * The Cinder site navigation: logo, four section links, "See Trackpr" and
 * the primary "Talk to Cinder". Below lg the links fold into a menu panel -
 * a disclosure (button + aria-expanded + aria-controls) that closes on
 * Escape, on a link, and on resize to desktop, returning focus to its
 * toggle. The bar gains a hairline once the page scrolls. `talkHref` comes
 * from the server layout, so the contact address (an environment value) is
 * resolved once on the server and never re-derived in the client bundle.
 */
export function CinderNav({ talkHref }: { talkHref: string }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth >= 1024) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className={`sticky top-0 z-40 border-b transition-colors duration-200 ${scrolled || open ? "border-cinder-line bg-cinder-canvas/90 backdrop-blur-md" : "border-transparent bg-cinder-canvas"}`}>
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-6 px-5 sm:px-8 lg:px-10">
        <Link href="/" aria-label="Cinder Revenue Company - home" className={`-m-1 rounded-md p-1 ${FOCUS}`}>
          <CinderLogo className="h-[26px] w-auto" title="Cinder" />
        </Link>

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={`rounded-full px-3.5 py-2 text-sm font-medium text-cinder-ink-2 transition-colors hover:bg-cinder-well hover:text-cinder-ink ${FOCUS}`}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Link href={TRACKPR_HREF} className={`rounded-full px-3.5 py-2 text-sm font-medium text-cinder-ink-2 transition-colors hover:text-cinder-ink ${FOCUS}`}>
            See Trackpr
          </Link>
          <Button href={talkHref} arrow>
            Talk to Cinder
          </Button>
        </div>

        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="cinder-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className={`-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-cinder-ink transition-colors hover:bg-cinder-well lg:hidden ${FOCUS}`}
        >
          {open ? <X className="h-5 w-5" strokeWidth={1.75} aria-hidden /> : <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />}
        </button>
      </div>

      <div id="cinder-menu" hidden={!open} className="border-t border-cinder-line bg-cinder-canvas lg:hidden">
        <nav aria-label="Primary" className="mx-auto w-full max-w-[1240px] px-5 pb-6 pt-2 sm:px-8">
          <ul className="divide-y divide-cinder-line">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} onClick={() => setOpen(false)} className={`flex min-h-14 items-center text-[17px] font-medium text-cinder-ink ${FOCUS}`}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Button href={talkHref} arrow size="lg">
              Talk to Cinder
            </Button>
            <Button href={TRACKPR_HREF} variant="secondary" size="lg">
              See Trackpr
            </Button>
          </div>
        </nav>
      </div>
    </header>
  );
}
