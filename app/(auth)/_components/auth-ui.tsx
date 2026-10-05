import type { ReactNode } from "react";

/**
 * The sign-in surface's own presentation primitives (login, signup,
 * forgot-password, reset-password), drawn from the Cinder website's
 * system: Geist on the warm canvas, white surfaces, warm hairlines, the
 * pine-ink pill button and ember accent. Deliberately separate from
 * lib/ui/auth-form.ts, which onboarding still uses. Presentation only -
 * every form keeps its own field names, server action and pending state.
 */

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent";

export const authFieldClass =
  "block h-12 w-full rounded-xl border border-cinder-line-strong bg-cinder-surface px-4 text-[15px] text-cinder-ink shadow-[0_1px_2px_rgba(13,21,18,0.04)] transition-[border-color,box-shadow] duration-150 placeholder:text-cinder-ink-3/70 hover:border-cinder-ink/30 focus:border-cinder-ink focus:outline-none focus:ring-[3px] focus:ring-cinder-ink/10 disabled:cursor-not-allowed disabled:bg-cinder-well disabled:text-cinder-ink-3";

export const authLabelClass = "text-[13px] font-medium text-cinder-ink";

export const authButtonClass = `inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-cinder-ink px-6 text-[15px] font-medium text-cinder-on-night shadow-[0_1px_2px_rgba(13,21,18,0.2)] transition-colors duration-200 hover:bg-[#1c2824] disabled:cursor-wait disabled:bg-cinder-ink/80 ${FOCUS_RING}`;

/** Quiet inline links (Forgot password?, Sign in, Create an account). */
export const authLinkClass = `rounded font-medium text-cinder-ink underline decoration-cinder-line-strong underline-offset-4 transition-colors hover:decoration-cinder-ink ${FOCUS_RING}`;

/** The checkbox on signup, in Cinder ink. */
export const authCheckboxClass = `mt-0.5 h-4 w-4 shrink-0 rounded border-cinder-line-strong accent-cinder-ink ${FOCUS_RING}`;

/** Trackpr's tile - the product's mark exactly as the app and the Cinder site show it (the app's accent). */
export function TrackprTile({ className = "h-7 w-7 rounded-lg text-[14px]" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center bg-accent font-bold leading-none text-white ${className}`}>
      T
    </span>
  );
}

/**
 * The top of every sign-in panel: the product (Trackpr) above the task.
 * `title` is the page's one h1.
 */
export function AuthHeader({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-cinder-ink">
        <TrackprTile />
        Trackpr
      </p>
      <h1 className="mt-8 text-balance text-[30px] font-semibold leading-[1.08] tracking-[-0.035em] text-cinder-ink sm:text-[34px]">{title}</h1>
      {subtitle ? <p className="mt-2.5 text-pretty text-[15px] leading-relaxed text-cinder-ink-2">{subtitle}</p> : null}
    </div>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** A calm, announced error. `id` lets the fields reference it via aria-describedby. */
export function AuthError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger-border bg-danger-muted px-4 py-3 text-[14px] leading-relaxed text-danger-text">
      <AlertIcon />
      <span>{children}</span>
    </p>
  );
}

export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2.5 rounded-xl border border-cinder-line bg-cinder-well px-4 py-3 text-left text-[14px] leading-relaxed text-cinder-ink-2">
      <span className="text-cinder-accent">
        <CheckIcon />
      </span>
      <span>{children}</span>
    </p>
  );
}

/** The primary action. Pending keeps the same height and width, so nothing shifts. */
export function AuthSubmit({ pending, idleLabel, pendingLabel }: { pending: boolean; idleLabel: string; pendingLabel: string }) {
  return (
    <button type="submit" disabled={pending} aria-busy={pending || undefined} className={authButtonClass}>
      {pending ? (
        <>
          <svg aria-hidden className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
          </svg>
          <span>{pendingLabel}</span>
        </>
      ) : (
        idleLabel
      )}
    </button>
  );
}
