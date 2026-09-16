import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 bg-slate-50">
      <div className="hidden w-1/2 flex-col justify-between bg-slate-900 p-12 lg:flex">
        <span className="text-lg font-semibold tracking-tight text-white">
          Trackpr
        </span>
        <div className="space-y-3">
          <p className="text-2xl font-medium leading-snug text-slate-100">
            Your contractor growth control center.
          </p>
          <p className="text-sm text-slate-400">
            Leads, conversations, and jobs - all in one place.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          &copy; {new Date().getFullYear()} Trackpr
        </span>
      </div>
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
