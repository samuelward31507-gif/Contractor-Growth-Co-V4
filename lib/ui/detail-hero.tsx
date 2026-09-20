import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The shared dark hero shell for every detail page (Lead/Contact/
 * Appointment/Estimate/Job) - same construction as the dashboard's own
 * command header and the marketing site's hero (radial emerald glow + faint
 * technical grid over near-black), so every "you clicked into a record"
 * moment in the product reads as the same brand, not five different pages
 * that happen to share a color.
 *
 * Deliberately just the shell: eyebrow/back-link/identity/action are common
 * structure, but `meta` is an open slot for whatever key context actually
 * matters for that entity (a lead's temperature + value, an appointment's
 * date/time, an estimate or job's amount, a contact's relationship counts) -
 * the five pages share this grammar without being mechanically identical.
 */
export function DetailHero({
  eyebrow,
  backHref,
  backLabel,
  avatar,
  title,
  subtitle,
  badges,
  action,
  meta,
}: {
  eyebrow: string;
  backHref: string;
  backLabel: string;
  avatar?: ReactNode;
  title: string;
  subtitle?: string;
  badges?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden bg-[#0a120f] px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_60%_at_10%_-30%,rgba(16,185,129,0.16),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(to_right,#fff_1px,transparent_1px),linear-gradient(to_bottom,#fff_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_70%_70%_at_20%_0%,black,transparent)]"
      />

      <div className="relative">
        <Link href={backHref} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-400 transition-colors hover:text-white">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {backLabel}
        </Link>

        <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            {avatar}
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-400">{eyebrow}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1>
              {subtitle ? <p className="mt-0.5 text-sm text-slate-400">{subtitle}</p> : null}
              {badges ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{badges}</div> : null}
            </div>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>

        {meta ? <div className="relative mt-6 border-t border-white/10 pt-5">{meta}</div> : null}
      </div>
    </div>
  );
}
