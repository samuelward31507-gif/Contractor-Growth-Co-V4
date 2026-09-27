import { redirect } from "next/navigation";

/**
 * IA consolidation pass: this route (and the "Analytics" name) moved to
 * /insights - the redesign audit found the page's own H1 ("Analytics")
 * disagreeing with the nav's own label at the time ("Numbers"); "Insights"
 * is now the one name used everywhere this page is reachable from. Kept as
 * a redirect, not deleted, so any bookmarked or externally-linked
 * /analytics URL (with its query params - the range tabs/activity filters)
 * keeps working instead of 404ing, matching the established
 * /activity -> /insights / /automation-health -> /automations pattern.
 */
export default async function LegacyAnalyticsRedirect({ searchParams }: PageProps<"/analytics">) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") nextParams.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) nextParams.set(key, value[0]);
  }
  const query = nextParams.toString();
  redirect(query ? `/insights?${query}` : "/insights");
}
