import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { surfaceClass } from "@/lib/ui/surface";
import { primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { NeedsAttentionItem } from "@/lib/agency/needs-attention";

/**
 * Agency Command Center 2.0 - the dominant section on the page, mirroring
 * app/(app)/dashboard/_components/attention-panel.tsx's exact treatment (a
 * real heading, not a receding label; rows flush on the canvas with divider
 * lines, not inside a bordered/tinted card; a confirmed-healthy empty state
 * gets the one distinct surface on the page). Every item comes from
 * lib/agency/needs-attention.ts, which only ever surfaces real, derivable
 * operational conditions - nothing is computed, scored, or invented here.
 */
export function NeedsAttention({ items }: { items: NeedsAttentionItem[] }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className={primarySectionTitleClass}>Needs your attention</h2>
        {items.length > 0 ? <span className={metaClass}>{items.length}</span> : null}
      </div>

      {items.length === 0 ? (
        <div className={`${surfaceClass} mt-5 px-6 py-14 text-center`}>
          <p className="text-base font-medium text-slate-900">All clients are operating normally.</p>
          <p className="mt-1.5 text-sm text-slate-500">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {items.map((item) => (
            <Link
              key={item.id}
              href={item.actionHref}
              className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-slate-50"
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  item.severity === "critical" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {item.problem} <span className="text-slate-400">— {item.organizationName}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">{formatRelativeTime(item.timestamp)}</span>
                </span>
                <span className="block truncate text-xs text-slate-500">{item.why}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
