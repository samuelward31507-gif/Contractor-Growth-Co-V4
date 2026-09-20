/**
 * Shared layout primitives for the Contractor Growth Co. marketing site -
 * deliberately separate from lib/ui/* (the Trackpr app's dense-CRM design
 * system tuned around 24-30px page titles and compact stat rows). A
 * marketing page needs a much bigger type scale and more generous section
 * rhythm than an authenticated dashboard, so these are their own small,
 * consistent set rather than overloading the app's primitives with a second
 * unrelated purpose.
 */
import type { ReactNode } from "react";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-6 sm:px-8 lg:px-10 ${className}`}>{children}</div>;
}

export function Section({
  children,
  className = "",
  id,
  tone = "light",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  tone?: "light" | "dark" | "subtle";
}) {
  // The dark tone uses the exact same near-black as Trackpr's own sidebar
  // (see app/(app)/_components/sidebar-content.tsx) - the two products share
  // one dark token, not two similar-but-different near-blacks.
  const toneClass =
    tone === "dark" ? "bg-[#0a120f] text-white" : tone === "subtle" ? "bg-slate-50" : "bg-white";
  return (
    <section id={id} className={`${toneClass} py-20 sm:py-24 lg:py-28 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

export function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <p
      className={`text-xs font-semibold uppercase tracking-[0.14em] ${
        dark ? "text-emerald-400" : "text-emerald-700"
      }`}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  dark = false,
  align = "left",
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  dark?: boolean;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={`max-w-2xl ${align === "center" ? "mx-auto text-center" : ""} ${className}`}>
      {eyebrow ? (
        <div className="mb-3">
          <Eyebrow dark={dark}>{eyebrow}</Eyebrow>
        </div>
      ) : null}
      <h2
        className={`text-3xl font-semibold tracking-tight sm:text-4xl ${dark ? "text-white" : "text-slate-900"}`}
      >
        {title}
      </h2>
      {description ? (
        <p className={`mt-4 text-lg leading-relaxed ${dark ? "text-slate-300" : "text-slate-600"}`}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
