import { redirect } from "next/navigation";

/**
 * IA consolidation pass: Work is no longer its own destination - every
 * table, toolbar, summary, empty state, and Add button it used is now
 * reached from /money (MoneyTabs' "All estimates"/"All jobs"), and its own
 * curated "Needs to move" queue was replaced by Money's own curated groups
 * (Quotes out / Ready to schedule / Won not finished) - see money/page.tsx's
 * own header comment for exactly what carried over. Kept as a redirect, not
 * deleted, so any bookmarked or externally-linked /work URL (with or
 * without its old `type=estimates`/`type=jobs` param) keeps working instead
 * of 404ing, matching the established /activity -> /analytics /
 * /automation-health -> /automations pattern.
 */
export default async function LegacyWorkRedirect({ searchParams }: PageProps<"/work">) {
  const params = await searchParams;
  const type = typeof params.type === "string" ? params.type : undefined;
  if (type === "estimates") {
    redirect("/money?browse=estimates");
  }
  if (type === "jobs") {
    redirect("/money?browse=jobs");
  }
  redirect("/money");
}
