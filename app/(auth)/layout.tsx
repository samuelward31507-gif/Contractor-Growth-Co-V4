import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CinderLogo, CinderMark } from "@/app/(cinder)/_components/logo";
import { STAGES } from "@/app/(cinder)/_components/content";
import { TrackprTile } from "./_components/auth-ui";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

/**
 * The sign-in surface (login, signup, forgot-password, and reset-password,
 * which reuses this component directly): Cinder -> Trackpr -> the task.
 *
 * Desktop: a quiet pine brand zone on the left (Cinder, the Cinder ->
 * Trackpr lockup, one statement, the revenue lifecycle as texture) and the
 * task on the warm canvas on the right, inside a white panel. The brand
 * zone is deliberately narrower and lower in contrast than the panel - the
 * form is the job. Mobile drops the brand zone entirely: Cinder at the
 * top, the task, then the footer - no dark block above the fold.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 bg-cinder-canvas text-cinder-ink [font-feature-settings:'ss01','cv11']">
      <aside className="relative hidden w-[40%] max-w-[600px] shrink-0 flex-col justify-between overflow-hidden bg-cinder-night px-12 py-12 text-cinder-on-night lg:flex xl:px-16 xl:py-14">
        <Link href="/" aria-label="Cinder Revenue Company - home" className={`-m-1 self-start rounded-md p-1 ${FOCUS}`}>
          <CinderLogo tone="light" variant="full" className="h-10 w-auto" title="Cinder Revenue Company" />
        </Link>

        <div className="max-w-[420px]">
          <p className="flex items-center gap-3 text-sm text-cinder-on-night-2">
            <span className="inline-flex items-center gap-2 font-medium text-cinder-on-night">
              <CinderMark tone="light" className="h-5 w-5" />
              Cinder
            </span>
            <span aria-hidden className="h-px w-8 bg-cinder-night-line" />
            <span className="inline-flex items-center gap-2 font-medium text-cinder-on-night">
              <TrackprTile className="h-5 w-5 rounded-[5px] text-[11px]" />
              Trackpr
            </span>
          </p>
          <p className="mt-8 text-balance text-[36px] font-semibold leading-[1.06] tracking-[-0.035em] xl:text-[42px]">Your revenue, running in one place.</p>
          <p className="mt-5 max-w-[360px] text-pretty text-[16px] leading-relaxed text-cinder-on-night-2">The first revenue operating system from Cinder.</p>

          {/* The lifecycle Trackpr runs, as quiet texture - not a diagram to study. */}
          <ol aria-label="The revenue lifecycle" className="mt-12 flex flex-wrap items-center gap-x-2 gap-y-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-cinder-on-night-3">
            {STAGES.map((stage, i) => (
              <li key={stage.key} className="flex items-center gap-2">
                <span className={stage.pivotal ? "text-cinder-accent-on-night" : undefined}>{stage.label}</span>
                {i < STAGES.length - 1 ? <span aria-hidden className="h-px w-3 bg-cinder-night-line" /> : null}
              </li>
            ))}
          </ol>
        </div>

        <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-cinder-on-night-3">Trackpr is a product of Cinder Revenue Company</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center px-5 sm:px-8 lg:h-20 lg:justify-end lg:px-10">
          {/* Mobile: the company, home. Desktop: the brand zone carries Cinder, so just the way back. */}
          <Link href="/" aria-label="Cinder Revenue Company - home" className={`-m-1 inline-flex items-center gap-2 rounded-md p-1 text-[15px] font-semibold tracking-[-0.01em] text-cinder-ink lg:hidden ${FOCUS}`}>
            <CinderMark className="h-6 w-6" />
            Cinder
          </Link>
          <Link href="/" className={`hidden items-center gap-1.5 rounded-full px-1 py-2 text-[13px] font-medium text-cinder-ink-2 transition-colors hover:text-cinder-ink lg:inline-flex ${FOCUS}`}>
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Back to Cinder
          </Link>
        </header>

        <main id="main" className="flex flex-1 items-start justify-center px-5 pb-10 pt-6 sm:items-center sm:px-8 sm:py-10">
          <div className="w-full max-w-[440px] sm:rounded-[24px] sm:border sm:border-cinder-line sm:bg-cinder-surface sm:p-10 sm:shadow-[0_1px_2px_rgba(13,21,18,0.04),0_12px_32px_-16px_rgba(13,21,18,0.12)]">
            {children}
          </div>
        </main>

        <footer className="flex flex-col items-center gap-2 px-5 pb-8 text-[12px] text-cinder-ink-3 sm:flex-row sm:justify-center sm:gap-5 lg:px-10">
          <p>© {new Date().getFullYear()} Cinder Revenue Company</p>
          <nav aria-label="Legal" className="flex items-center gap-4">
            <Link href="/terms" className={`rounded transition-colors hover:text-cinder-ink ${FOCUS}`}>
              Terms
            </Link>
            <Link href="/privacy" className={`rounded transition-colors hover:text-cinder-ink ${FOCUS}`}>
              Privacy
            </Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
