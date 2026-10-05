export { formatCurrency as formatUsd } from "@/lib/dashboard/format";

/** Small wording helpers for agent findings - plain counts and singular/plural pairs. */
export const formatCount = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const percent = (rate: number) => `${Math.round(rate * 100)}%`;
