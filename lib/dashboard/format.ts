// Batch 1 (Cinder design foundation): the canonical formatters live in
// lib/format/ - these names stay for their existing importers.
import { formatCurrency as formatCanonicalCurrency } from "@/lib/format/money";

export { formatRelativeTime } from "@/lib/format/datetime";

/** Whole dollars - headline figures and KPIs. */
export function formatCurrency(value: number): string {
  return formatCanonicalCurrency(value, { cents: "never" });
}
