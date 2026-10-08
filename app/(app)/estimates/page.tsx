import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/navigation/legacy-redirect";

/**
 * Batch 2: Estimates is a view inside Money (/money?browse=estimates), the
 * one financial destination - the same EstimatesSummary / EstimatesToolbar /
 * EstimatesTable this page used to render, so nothing is duplicated. Every
 * query param is kept: `q`/`status` filters, and the `?new=estimate&
 * contactId=...` deep link that opens the Add estimate dialog (the dialog
 * reads them on Money exactly as it did here). /estimates/[id] is unchanged.
 */
export default async function LegacyEstimatesRedirect({ searchParams }: PageProps<"/estimates">) {
  redirect(legacyRedirectTarget("/money", await searchParams, { browse: "estimates" }));
}
