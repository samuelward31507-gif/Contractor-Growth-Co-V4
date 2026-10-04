import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { pageEyebrowClass, pageTitleClass } from "./typography";
import { PAGE_MAX_WIDTH_CLASS } from "./page";

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
    // Trackpr 2.0 (step 2G): the header's content sits in the same centered
    // 1280px column as the page body beneath it (the hairline still spans
    // the full width), so the two line up on wide screens.
    <div className="border-b border-line bg-surface">
      <div className={`${PAGE_MAX_WIDTH_CLASS} px-4 py-6 sm:px-6 sm:py-8 lg:px-10`}>
      <Link
        href={backHref}
        className="-my-3 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm font-medium text-ink-3 transition-colors duration-150 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:my-0 sm:min-h-0"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {backLabel}
      </Link>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {avatar}
          <div className="min-w-0">
            <p className={pageEyebrowClass}>{eyebrow}</p>
            <h1 className={`mt-1 ${pageTitleClass}`}>{title}</h1>
            {subtitle ? <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p> : null}
            {badges ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{badges}</div> : null}
          </div>
        </div>
        {action ? <div className="min-w-0 max-w-full sm:shrink-0 [&>*]:flex-wrap">{action}</div> : null}
      </div>

      {meta ? <div className="mt-6 border-t border-line pt-5">{meta}</div> : null}
      </div>
    </div>
  );
}
