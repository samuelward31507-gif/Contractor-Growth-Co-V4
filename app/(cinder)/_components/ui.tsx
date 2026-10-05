import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

/**
 * Cinder website primitives - Button, Section, Card, Badge, Eyebrow. One
 * place for the site's shapes so every section composes the same parts.
 */

export const CONTAINER = "mx-auto w-full max-w-[1240px] px-5 sm:px-8 lg:px-10";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

type ButtonVariant = "primary" | "secondary" | "inverse" | "inverse-secondary";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-cinder-ink text-cinder-on-night shadow-[0_1px_2px_rgba(13,21,18,0.2)] hover:bg-[#1c2824]",
  secondary: "bg-cinder-surface text-cinder-ink ring-1 ring-cinder-line-strong hover:ring-cinder-ink/40",
  inverse: "bg-cinder-on-night text-cinder-ink hover:bg-white",
  "inverse-secondary": "text-cinder-on-night ring-1 ring-cinder-night-line hover:bg-cinder-night-fill hover:ring-cinder-on-night-3",
};

/** A link styled as a button. `arrow` adds the trailing arrow that nudges on hover. mailto: and external hrefs render a plain <a>. */
export function Button({ href, children, variant = "primary", arrow = false, size = "md", className = "" }: { href: string; children: ReactNode; variant?: ButtonVariant; arrow?: boolean; size?: "md" | "lg"; className?: string }) {
  const cls = `group inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background-color,box-shadow,color] duration-200 ${size === "lg" ? "h-12 px-6 text-[15px]" : "h-10 px-[18px] text-sm"} ${BUTTON[variant]} ${FOCUS} ${className}`;
  const inner = (
    <>
      {children}
      {arrow ? <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden /> : null}
    </>
  );
  if (href.startsWith("mailto:") || href.startsWith("http")) {
    return (
      <a href={href} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}

/** A quiet text link with an arrow - the secondary action inside sections. */
export function TextLink({ href, children, tone = "ink" }: { href: string; children: ReactNode; tone?: "ink" | "light" }) {
  return (
    <Link
      href={href}
      className={`group inline-flex items-center gap-1.5 rounded text-sm font-medium transition-colors ${tone === "ink" ? "text-cinder-ink hover:text-cinder-accent" : "text-cinder-on-night hover:text-cinder-accent-on-night"} ${FOCUS}`}
    >
      {children}
      <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

/**
 * The small label above a heading: compact Geist Mono notation led by a tiny
 * ember square - the mark's spark, reused as the site's one recurring detail.
 */
export function Eyebrow({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "light" }) {
  return (
    <p className={`flex items-center gap-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] ${tone === "ink" ? "text-cinder-ink-3" : "text-cinder-on-night-3"}`}>
      <span aria-hidden className={`h-[5px] w-[5px] rotate-45 ${tone === "ink" ? "bg-cinder-accent" : "bg-cinder-accent-on-night"}`} />
      {children}
    </p>
  );
}

/** The site's section-heading scale - one place, so every h2 carries the same weight. */
export const H2 = "text-balance text-[36px] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-[48px] lg:text-[60px]";

type SectionTone = "canvas" | "surface" | "night";

const SECTION_TONE: Record<SectionTone, string> = {
  canvas: "bg-cinder-canvas text-cinder-ink",
  surface: "bg-cinder-surface text-cinder-ink",
  night: "bg-cinder-night text-cinder-on-night",
};

/** A page section: tone, rhythm and an optional heading block (eyebrow, h2, intro). */
export function Section({
  id,
  tone = "canvas",
  eyebrow,
  title,
  intro,
  children,
  className = "",
  headingAlign = "left",
}: {
  id?: string;
  tone?: SectionTone;
  eyebrow?: ReactNode;
  title?: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingAlign?: "left" | "center";
}) {
  const light = tone === "night";
  return (
    <section id={id} aria-labelledby={id && title ? `${id}-title` : undefined} className={`scroll-mt-16 py-20 sm:py-28 lg:py-36 ${SECTION_TONE[tone]} ${className}`}>
      <div className={CONTAINER}>
        {title ? (
          <div className={`max-w-[760px] ${headingAlign === "center" ? "mx-auto text-center [&>p:first-child]:justify-center" : ""}`}>
            {eyebrow ? <Eyebrow tone={light ? "light" : "ink"}>{eyebrow}</Eyebrow> : null}
            <h2 id={id ? `${id}-title` : undefined} className={`${eyebrow ? "mt-6" : ""} ${H2}`}>
              {title}
            </h2>
            {intro ? <p className={`mt-6 max-w-[620px] text-pretty text-[17px] leading-relaxed sm:text-[19px] ${headingAlign === "center" ? "mx-auto" : ""} ${light ? "text-cinder-on-night-2" : "text-cinder-ink-2"}`}>{intro}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/** The site's one card surface. */
export function Card({ children, className = "", as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" | "article" }) {
  return <Tag className={`rounded-2xl border border-cinder-line bg-cinder-surface p-6 shadow-[0_1px_2px_rgba(13,21,18,0.04)] sm:p-7 ${className}`}>{children}</Tag>;
}

/** A small status pill. `accent` for the one thing that is live; `muted` for what is not yet. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "muted" | "night" }) {
  const t = {
    neutral: "bg-cinder-well text-cinder-ink-2 inset-ring-cinder-line",
    accent: "bg-cinder-accent-soft text-cinder-accent-strong inset-ring-cinder-accent/20",
    muted: "bg-transparent text-cinder-ink-3 inset-ring-cinder-line-strong",
    night: "bg-cinder-night-fill text-cinder-on-night-2 inset-ring-cinder-night-line",
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium inset-ring ${t}`}>{children}</span>;
}
