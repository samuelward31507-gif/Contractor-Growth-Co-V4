import Link from "next/link";
import { Container } from "./section";

const FOOTER_LINKS = [
  { href: "/how-it-works", label: "How It Works" },
  { href: "/services", label: "What We Build" },
  { href: "/get-started", label: "Get Started" },
  { href: "/login", label: "Login" },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <Container className="py-14">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-900">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-xs font-bold text-white">
                C
              </span>
              Contractor Growth Co.
            </span>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">
              Your website, AI, follow-up, and business analytics — all working together.
            </p>
          </div>

          <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3">
            {FOOTER_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-12 border-t border-slate-100 pt-6">
          <p className="text-xs text-slate-400">&copy; {new Date().getFullYear()} Contractor Growth Co. All rights reserved.</p>
        </div>
      </Container>
    </footer>
  );
}
