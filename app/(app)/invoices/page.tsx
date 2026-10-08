import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/navigation/legacy-redirect";

/**
 * Batch 2: /invoices had no list page of its own (only /invoices/[id]), so a
 * bare /invoices link 404'd. The invoice list is Money's Invoices view; send
 * the visitor there with any `q`/`status` filter kept.
 */
export default async function LegacyInvoicesRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyRedirectTarget("/money", await searchParams, { browse: "invoices" }));
}
