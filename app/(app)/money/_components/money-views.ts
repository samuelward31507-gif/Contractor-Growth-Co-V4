/**
 * Batch 2: Money is the one financial destination - Overview, Estimates,
 * Jobs, Invoices, Payments are its views (the old /estimates, /jobs and
 * /invoices lists redirect here). `browse` stays the query key every
 * existing link already uses; `view` is accepted as an alias. Pure, so the
 * shell and tests share it.
 */
export type MoneyTab = "money" | "estimates" | "jobs" | "invoices" | "payments";

export const MONEY_TABS: { value: MoneyTab; label: string; href: string }[] = [
  { value: "money", label: "Overview", href: "/money" },
  { value: "estimates", label: "Estimates", href: "/money?browse=estimates" },
  { value: "jobs", label: "Jobs", href: "/money?browse=jobs" },
  { value: "invoices", label: "Invoices", href: "/money?browse=invoices" },
  { value: "payments", label: "Payments", href: "/money?browse=payments" },
];

/** The Money view a URL asks for; anything else is the Overview. */
export function normalizeBrowse(value: string | undefined): MoneyTab {
  return MONEY_TABS.find((tab) => tab.value === value)?.value ?? "money";
}
