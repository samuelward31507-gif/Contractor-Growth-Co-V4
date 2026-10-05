import Link from "next/link";
import { CinderLogo } from "./logo";
import { CONTAINER } from "./ui";
import { NAV_LINKS, TRACKPR_DEMO_HREF, TRACKPR_HREF } from "./content";

const FOCUS = "rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";
const LINK = `text-sm text-cinder-ink-2 transition-colors hover:text-cinder-ink ${FOCUS}`;

export function CinderFooter() {
  return (
    <footer className="border-t border-cinder-line bg-cinder-canvas">
      <div className={`${CONTAINER} py-14 sm:py-16`}>
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-sm">
            <CinderLogo variant="full" className="h-10 w-auto" />
            <p className="mt-5 text-sm leading-relaxed text-cinder-ink-3">Revenue systems that turn more opportunities into revenue. Trackpr is the first.</p>
          </div>
          <nav aria-label="Footer">
            <h2 className="text-xs font-medium text-cinder-ink-3">Cinder</h2>
            <ul className="mt-4 space-y-3">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={LINK}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div>
            <h2 className="text-xs font-medium text-cinder-ink-3">Trackpr · flagship product</h2>
            <ul className="mt-4 space-y-3">
              <li>
                <Link href={TRACKPR_HREF} className={LINK}>
                  Overview
                </Link>
              </li>
              <li>
                <Link href={TRACKPR_DEMO_HREF} className={LINK}>
                  Interactive demo
                </Link>
              </li>
              <li>
                <Link href="/get-started" className={LINK}>
                  Get started
                </Link>
              </li>
              <li>
                <Link href="/login" className={LINK}>
                  Sign in
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="text-xs font-medium text-cinder-ink-3">Legal</h2>
            <ul className="mt-4 space-y-3">
              <li>
                <Link href="/privacy" className={LINK}>
                  Privacy
                </Link>
              </li>
              <li>
                <Link href="/terms" className={LINK}>
                  Terms
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-14 flex flex-col gap-3 border-t border-cinder-line pt-6 text-xs text-cinder-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Cinder Revenue Company</p>
          <p>Trackpr is a product of Cinder Revenue Company.</p>
        </div>
      </div>
    </footer>
  );
}
