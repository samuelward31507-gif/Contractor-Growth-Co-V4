import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/navigation/legacy-redirect";

/**
 * Batch 2: Jobs is a view inside Money (/money?browse=jobs), the one
 * financial destination - the same JobsSummary / review & referral summary /
 * JobsToolbar / JobsTable this page used to render. Every query param is
 * kept (`q`, `status`, `?new=...`). /jobs/[id] is unchanged.
 */
export default async function LegacyJobsRedirect({ searchParams }: PageProps<"/jobs">) {
  redirect(legacyRedirectTarget("/money", await searchParams, { browse: "jobs" }));
}
