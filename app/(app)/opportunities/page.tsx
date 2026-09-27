import { redirect } from "next/navigation";

/**
 * IA consolidation pass: Opportunities is no longer its own primary nav
 * destination - it's a real view of /today now (TodayViewTabs' "By type"
 * tab, reusing this page's own OpportunitiesList component and query
 * unmodified - see today/page.tsx's own header comment). Kept as a
 * redirect, not deleted, so any bookmarked or externally-linked
 * /opportunities URL keeps working instead of 404ing - the same
 * established pattern already used for /activity -> /analytics and
 * /automation-health -> /automations.
 */
export default function LegacyOpportunitiesRedirect() {
  redirect("/today?view=by-type");
}
