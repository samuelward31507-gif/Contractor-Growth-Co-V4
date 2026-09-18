import { AlertTriangle, CheckCircle2 } from "lucide-react";

const TONE_CLASS = {
  attention: "bg-amber-50 text-amber-700",
  healthy: "bg-emerald-50 text-emerald-700",
  neutral: "bg-slate-100 text-slate-600",
} as const;

/**
 * The one status indicator used everywhere attention state is shown
 * (client health table, attention section) - always reads directly from a
 * boolean/value the backend already computed, never derives health itself.
 */
export function StatusPill({ tone, label }: { tone: keyof typeof TONE_CLASS; label: string }) {
  const Icon = tone === "attention" ? AlertTriangle : tone === "healthy" ? CheckCircle2 : null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      {label}
    </span>
  );
}
