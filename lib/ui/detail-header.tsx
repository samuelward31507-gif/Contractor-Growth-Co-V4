import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { sectionLabelClass, pageTitleClass } from "./typography";

/**
 * The shared header for every detail page (Lead/Contact/Appointment/
 * Estimate/Job). Replaces the earlier dark full-bleed "hero" treatment -
 * a separate near-black block with its own glow/grid read as a decorative
 * effect bolted onto the page rather than part of one coherent workspace,
 * and it gave every record the same oversized opening moment regardless of
 * how much it actually needed. This is the same light surface as the rest
 * of the page, using the same PageHeader typography every list page already
 * uses (eyebrow / title / description), so a detail page reads as "one more
 * screen in this product," not a separate visual event.
 *
 * Deliberately just the shell: eyebrow/back-link/identity/action are common
 * structure, but `meta` is an open slot for whatever key fact actually
 * matters for that entity (a lead's temperature + value, an appointment's
 * date/time, an estimate or job's amount, a contact's relationship counts) -
 * the five pages share this grammar without being mechanically identical.
 */
export function DetailHeader({
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
    <div className="border-b border-slate-200 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <Link
        href={backHref}
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {backLabel}
      </Link>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {avatar}
          <div className="min-w-0">
            <p className={sectionLabelClass}>{eyebrow}</p>
            <h1 className={`mt-1 ${pageTitleClass}`}>{title}</h1>
            {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
            {badges ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{badges}</div> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      {meta ? <div className="mt-6 border-t border-slate-100 pt-5">{meta}</div> : null}
    </div>
  );
}
