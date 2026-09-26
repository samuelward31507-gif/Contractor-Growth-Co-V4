import { redirect } from "next/navigation";

/**
 * Trackpr 2.0, Phase 1 (Inbox route gap fix): the locked Trackpr 2.0
 * navigation points Inbox at /inbox, but Conversations uses a nested
 * list+detail layout (app/(app)/conversations/layout.tsx) that cannot
 * safely receive the same thin-dispatcher treatment Phase 0 used for
 * Customers/Schedule/Work - re-exporting its page component alone would
 * render only the "select a conversation" empty state with no list pane,
 * since the list lives in the parent layout, not something a page can call
 * into. A route-level redirect is the smallest safe reconciliation,
 * following the exact same established pattern already shipped in this
 * codebase for app/(app)/activity/page.tsx -> /analytics (query-preserving)
 * and app/(app)/automation-health/page.tsx -> /automations.
 *
 * Conversations itself is completely untouched by this fix: its layout,
 * page, and [id] page are not modified, and every existing
 * conversations/${id} deep link (lib/reviews-referrals/tracking.ts,
 * lib/automation/booking-reply.ts, lib/automation/estimate-reply.ts,
 * lib/automation/customer-reply.ts, app/api/automation/n8n-callback/route.ts)
 * continues to resolve exactly as before.
 */
export default async function InboxRedirect(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") nextParams.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) nextParams.set(key, value[0]);
  }
  const query = nextParams.toString();
  redirect(query ? `/conversations?${query}` : "/conversations");
}
