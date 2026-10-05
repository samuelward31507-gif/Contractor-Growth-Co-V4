"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, LogIn } from "lucide-react";
import { CinderLogo } from "./logo";
import { Button } from "./ui";
import { NAV_LINKS, SIGN_IN_HREF, TRACKPR_HREF } from "./content";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

/**
 * The Cinder site navigation: logo left, the four section links centred,
 * "See Trackpr" and the primary "Talk to Cinder" right, with "Sign in" -
 * product access to the Trackpr application at /login - set apart from the
 * marketing actions by a hairline and a log-in glyph. The bar sits on the
 * canvas with no border until the page scrolls.
 *
 * Below lg the links fold into a full-height sheet - large type, the CTAs
 * pinned at its foot. It is a disclosure (button + aria-expanded +
 * aria-controls) that closes on Escape, on a link and on resize to desktop,
 * returning focus to its toggle; the page behind does not scroll while it
 * is open. `talkHref` comes from the server layout, so the contact address
 * (an environment value) is resolved once on the server.
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
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.documentElement.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    // Open: a solid bar with no backdrop-filter - a filter would become the
    // containing block for the fixed menu sheet and collapse it into the bar.
    <header
      className={`sticky top-0 z-40 transition-[background-color,box-shadow] duration-300 ${
        open ? "bg-cinder-canvas shadow-[0_1px_0_var(--cinder-line)]" : scrolled ? "bg-cinder-canvas/85 shadow-[0_1px_0_var(--cinder-line)] backdrop-blur-lg" : "bg-cinder-canvas"
      }`}
    >
      <div className="relative mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-6 px-5 sm:px-8 lg:h-[72px] lg:px-10">
        <Link href="/" aria-label="Cinder Revenue Company - home" className={`-m-1 shrink-0 rounded-md p-1 ${FOCUS}`}>
          <CinderLogo className="h-[24px] w-auto lg:h-[26px]" title="Cinder" />
        </Link>

        {/* Centred from xl; between lg and xl it sits in the flow so it never meets the actions on the right. */}
        <nav aria-label="Primary" className="hidden lg:block xl:absolute xl:left-1/2 xl:-translate-x-1/2">
          <ul className="flex items-center gap-0.5">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={`rounded-full px-4 py-2 text-[14px] font-medium text-cinder-ink-2 transition-colors duration-200 hover:bg-cinder-ink/[0.045] hover:text-cinder-ink ${FOCUS}`}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-1 lg:flex">
          <Link href={TRACKPR_HREF} className={`group inline-flex items-center gap-1 rounded-full px-4 py-2 text-[14px] font-medium text-cinder-ink-2 transition-colors duration-200 hover:text-cinder-ink ${FOCUS}`}>
            See Trackpr
          </Link>
          <span aria-hidden className="mx-1 h-5 w-px bg-cinder-line-strong" />
          <Link href={SIGN_IN_HREF} className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[14px] font-medium text-cinder-ink transition-colors duration-200 hover:bg-cinder-ink/[0.045] ${FOCUS}`}>
            <LogIn className="h-4 w-4 text-cinder-ink-3" strokeWidth={1.75} aria-hidden />
            Sign in
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
          className={`-mr-2.5 flex h-11 w-11 items-center justify-center rounded-full text-cinder-ink transition-colors hover:bg-cinder-ink/[0.05] lg:hidden ${FOCUS}`}
        >
          {/* Two lines that cross into an X - a quieter glyph than a three-bar menu. */}
          <span aria-hidden className="relative block h-3 w-[18px]">
            <span className={`absolute left-0 block h-[1.5px] w-full rounded bg-current transition-transform duration-300 ${open ? "top-[5px] rotate-45" : "top-[1px]"}`} />
            <span className={`absolute left-0 block h-[1.5px] w-full rounded bg-current transition-transform duration-300 ${open ? "top-[5px] -rotate-45" : "top-[9px]"}`} />
          </span>
        </button>
      </div>

      <div id="cinder-menu" hidden={!open} className="fixed inset-x-0 bottom-0 top-16 overflow-y-auto bg-cinder-canvas lg:hidden">
        <nav aria-label="Primary" className="mx-auto flex min-h-full w-full max-w-[640px] flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:px-8">
          <ul className="border-t border-cinder-line">
            {NAV_LINKS.map((link, i) => (
              <li key={link.href} className="cinder-rise border-b border-cinder-line" style={{ animationDelay: `${i * 40}ms` }}>
                <Link href={link.href} onClick={() => setOpen(false)} className={`group flex min-h-[68px] items-center justify-between gap-4 ${FOCUS}`}>
                  <span className="flex items-baseline gap-4">
                    <span className="font-mono text-[11px] text-cinder-ink-3">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-[28px] font-semibold tracking-[-0.03em] text-cinder-ink">{link.label}</span>
                  </span>
                  <ArrowRight className="h-5 w-5 text-cinder-ink-3 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href={SIGN_IN_HREF}
            onClick={() => setOpen(false)}
            className={`mt-8 flex min-h-12 items-center justify-between gap-4 rounded-xl px-4 text-[15px] font-medium text-cinder-ink inset-ring inset-ring-cinder-line-strong transition-colors hover:bg-cinder-ink/[0.03] ${FOCUS}`}
          >
            <span className="flex items-center gap-3 whitespace-nowrap">
              <LogIn className="h-[18px] w-[18px] text-cinder-ink-3" strokeWidth={1.75} aria-hidden />
              Sign in to Trackpr
            </span>
            <span className="hidden whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.12em] text-cinder-ink-3 min-[360px]:inline">Existing users</span>
          </Link>
          <div className="mt-auto grid gap-3 pt-10">
            <Button href={talkHref} arrow size="lg">
              Talk to Cinder
            </Button>
            <Button href={TRACKPR_HREF} variant="secondary" size="lg">
              See Trackpr
            </Button>
            <p className="mt-3 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-cinder-ink-3">Cinder Revenue Company</p>
          </div>
        </nav>
      </div>
    </header>
  );
}
