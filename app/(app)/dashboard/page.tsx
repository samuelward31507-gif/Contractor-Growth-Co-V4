import { redirect } from "next/navigation";

/**
 * IA consolidation pass: Dashboard's own unique content (the greeting/
 * Pipeline-value header, the daily briefing, what the AI handled, cached AI
 * insights) moved to /today - see today/page.tsx's own header comment for
 * exactly what moved and what didn't. Kept as a redirect, not deleted, so
 * any bookmarked or externally-linked /dashboard URL (including the login/
 * signup/reset-password/email-confirm post-auth redirect targets, all
 * updated to point at /today directly) keeps working instead of 404ing -
 * the same established pattern already used for /activity -> /analytics and
 * /automation-health -> /automations.
 */
export default async function LegacyDashboardRedirect({ searchParams }: PageProps<"/dashboard">) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") nextParams.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) nextParams.set(key, value[0]);
  }
  const query = nextParams.toString();
  redirect(query ? `/today?${query}` : "/today");
}
