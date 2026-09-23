"use client";

/**
 * V2 Foundation: the one route-level error-boundary UI, shared by every
 * `error.tsx` in the authenticated app (app/(app)/error.tsx,
 * app/agency/error.tsx). Before this, zero error.tsx files existed anywhere
 * in the app - an unhandled Server Component exception fell through to
 * Next.js's bare default error page, outside Trackpr's own design system and
 * with no way back into the product.
 *
 * Deliberately does NOT render `error.message` - Next.js strips server-side
 * error details from what reaches the client in production already, but the
 * message can still contain incidental detail (a raw exception string) that
 * has no business being user-facing. `error.digest`, by contrast, is Next's
 * own opaque, safe-by-design correlation id for matching a report against
 * server logs - shown only when present, never fabricated.
 *
 * Intentionally does NOT own the page shell/nav - it renders only the
 * content that replaces `{children}` inside whichever layout it's nested
 * under, so the sidebar/top bar/header health pill stay exactly where they
 * were on every other page. This is what "preserve existing navigation"
 * requires from an error.tsx by construction, not by extra markup here.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { primaryButtonAutoClass, secondaryButtonAutoClass } from "./form";

export function RouteError({
  error,
  reset,
  homeHref = "/dashboard",
  homeLabel = "Back to Dashboard",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
        <AlertTriangle className="h-6 w-6 text-red-500" aria-hidden />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-1.5 max-w-sm text-sm text-slate-500">
        This page ran into an unexpected error. It&apos;s been logged - try again, or head back and pick up where you left off.
      </p>
      {error.digest ? (
        <p className="mt-3 rounded-md bg-slate-50 px-2.5 py-1 font-mono text-[11px] text-slate-400">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-6 flex items-center gap-3">
        <button type="button" onClick={reset} className={primaryButtonAutoClass}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          Try again
        </button>
        <Link href={homeHref} className={secondaryButtonAutoClass}>
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
