/**
 * Phase 5 (nav and mobile pass): the hamburger + full-height drawer this
 * component used to render is gone - MobileTabBar (a persistent bottom tab
 * bar) now owns every mobile navigation duty, including the "More" sheet
 * for everything that isn't one of the four primary destinations. This is
 * left as the plain top branding strip only, unchanged in appearance from
 * before.
 */
export function MobileNav() {
  return (
    <div className="lg:hidden">
      <header className="relative flex items-center overflow-hidden border-b border-white/[0.06] bg-[#0a120f] px-4 py-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_80%_at_20%_-30%,rgba(16,185,129,0.10),transparent)]"
        />
        <span className="relative flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500 text-xs font-bold text-slate-950">
            T
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-tight tracking-tight text-white">Trackpr</span>
            <span className="block text-[12px] font-semibold uppercase tracking-[0.02em] text-emerald-400/80">Contractor Growth Co.</span>
          </span>
        </span>
      </header>
    </div>
  );
}
