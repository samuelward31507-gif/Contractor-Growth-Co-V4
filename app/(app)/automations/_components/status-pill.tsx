import { CheckCircle2, AlertTriangle, CircleDashed, CircleSlash, PauseCircle } from "lucide-react";
import type { AutomationDisplayStatus } from "@/lib/automation/queries";

const STATUS_CONFIG: Record<AutomationDisplayStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  active: { label: "Active", className: "bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  attention: { label: "Attention", className: "bg-amber-50 text-amber-700", icon: AlertTriangle },
  no_activity: { label: "No activity", className: "bg-slate-100 text-slate-600", icon: CircleDashed },
  not_configured: { label: "Not configured", className: "bg-slate-100 text-slate-500", icon: CircleSlash },
  disabled: { label: "Disabled", className: "bg-slate-100 text-slate-500", icon: PauseCircle },
};

/**
 * Reads directly from AutomationDisplayStatus, already computed server-side
 * in lib/automation/queries.ts from the real automation_settings.enabled
 * value (Phase G) plus real execution data - never re-derives status here.
 */
export function AutomationStatusPill({ status }: { status: AutomationDisplayStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {config.label}
    </span>
  );
}
