import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <div className="flex flex-col justify-between bg-slate-950 px-8 py-10 sm:px-12 sm:py-12 lg:w-[44%] lg:px-14 lg:py-14 xl:px-16">
        <span className="text-[15px] font-semibold tracking-tight text-white">Trackpr</span>

        <div className="max-w-sm py-10 lg:py-0">
          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-white sm:text-3xl">
            Your business.
            <br />
            Running in one place.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Trackpr connects your leads, conversations, and appointments so nothing falls through the cracks.
          </p>
        </div>

        <span className="hidden text-xs text-slate-600 lg:block">&copy; {new Date().getFullYear()} Trackpr</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center bg-white px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
