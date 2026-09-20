import Link from "next/link";
import type { ReactNode } from "react";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3.5 text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

const VARIANT: Record<"primary" | "secondary" | "secondaryDark" | "ghostDark", string> = {
  // The one accent CTA tier on the whole site - reserved for the primary
  // "Get Your Growth System" action, never used decoratively.
  primary: `${BASE} bg-emerald-600 text-white shadow-sm hover:bg-emerald-500 focus-visible:outline-emerald-600`,
  secondary: `${BASE} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 focus-visible:outline-slate-900`,
  secondaryDark: `${BASE} border border-white/20 bg-transparent text-white hover:bg-white/10 focus-visible:outline-white`,
  ghostDark: `${BASE} text-slate-200 hover:text-white focus-visible:outline-white`,
};

export function CtaLink({
  href,
  children,
  variant = "primary",
  className = "",
  onClick,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "secondaryDark" | "ghostDark";
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Link href={href} className={`${VARIANT[variant]} ${className}`} onClick={onClick}>
      {children}
    </Link>
  );
}
