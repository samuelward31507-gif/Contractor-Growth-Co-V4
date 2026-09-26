import type { NextConfig } from "next";

/**
 * Trackpr 2.0, Phase 0 (route strategy + migration safety): permanent
 * (308) server-side redirects from every legacy list/detail route to its
 * locked Trackpr 2.0 destination - see the Trackpr 2.0 Master Product
 * Specification's own Part 2 (Route Migration Map) and Part 25 (Routing
 * Strategy) for the full rationale. Chosen over middleware.ts (none exists
 * today - no reason to introduce one for a static path mapping) and over a
 * client-side redirect (would not work logged out, on refresh, or for a
 * historical SMS/email link opened outside a browser session - see every
 * `detailPath` use in lib/notifications/founder.ts's callers). next.config's
 * own redirects() run at the Next.js routing layer, before any page/layout
 * code (including app/(app)/layout.tsx's own auth/payment-gate redirect
 * chain) - so these work identically whether the requester is authenticated
 * or not, exactly matching this phase's own "must work without
 * authentication" requirement.
 *
 * Every legacy route (`/leads`, `/contacts`, `/calendar`, `/appointments`,
 * `/estimates`, `/jobs`, and their `[id]` children) remains fully present
 * and unmodified in the repository - only NEW requests to the old URLs are
 * redirected; nothing about the old pages' own implementation changed.
 *
 * Query parameters not referenced by name in `destination` are passed
 * through unchanged automatically (Next's own documented redirects()
 * behavior) - this is what preserves `/leads?temperature=hot`,
 * `/leads?status=...`, `/contacts?sort=...`, `/estimates?status=...`,
 * `/jobs?status=...`, and calendar's own `date`/`view` (day/week/month,
 * already compatible with the Trackpr 2.0 `view` vocabulary) without this
 * file needing to enumerate them.
 *
 * The one genuine collision: /appointments' own `view` query parameter
 * (upcoming/today/past - see app/(app)/appointments/page.tsx's own
 * VALID_VIEWS) uses the SAME query key name as the new /schedule route's
 * top-level view selector (day/week/month/list), but a completely different
 * vocabulary. Silently passing it through unchanged would corrupt
 * /schedule's own view selection. Per this phase's explicit "do not
 * silently drop query parameters ... preserve it when safe rather than
 * deleting information" instruction, it is captured and re-emitted under
 * its own distinct key (`apptView`) rather than discarded - see the two
 * /appointments rules below (with and without an incoming `view` param).
 * app/(app)/schedule/page.tsx reads `apptView` back out and forwards it to
 * the real, unmodified Appointments page component as that component's own
 * expected `view` prop.
 */
const nextConfig: NextConfig = {
  agentRules: false,
  async redirects() {
    return [
      // --- Customers (Leads + Contacts merge) ---
      { source: "/leads/:id", destination: "/customers/:id?from=lead", permanent: true },
      { source: "/leads", destination: "/customers?from=lead", permanent: true },
      { source: "/contacts/:id", destination: "/customers/:id?from=contact", permanent: true },
      { source: "/contacts", destination: "/customers?from=contact", permanent: true },

      // --- Schedule (Calendar + Appointments merge) ---
      // Calendar's own `view` (day/week/month) and `date` params are already
      // compatible with /schedule's vocabulary - passed through unchanged.
      { source: "/calendar", destination: "/schedule", permanent: true },
      // Appointments WITH its own `view` param present: rename it to
      // `apptView` so it never collides with /schedule's own `view` selector.
      {
        source: "/appointments",
        has: [{ type: "query", key: "view", value: "(?<apptView>.*)" }],
        destination: "/schedule?view=list&apptView=:apptView",
        permanent: true,
      },
      // Appointments with no `view` param at all.
      {
        source: "/appointments",
        missing: [{ type: "query", key: "view" }],
        destination: "/schedule?view=list",
        permanent: true,
      },

      // --- Estimates & Jobs merge ---
      // Only the LIST routes are in scope for Phase 0's locked route
      // decisions - /estimates/[id] and /jobs/[id] are not merged/renamed
      // anywhere in the spec, so they are deliberately left with no
      // redirect rule at all here: they remain fully reachable at their
      // existing URLs, unmodified, exactly as "old routes must not be
      // deleted" requires. The same reasoning applies to /appointments/[id]
      // (not in scope - only the /appointments LIST route merges below) -
      // historical notifyFounder detailPath links to /appointments/${id}
      // therefore need no redirect at all; that route is untouched.
      { source: "/estimates", destination: "/work?type=estimates", permanent: true },
      { source: "/jobs", destination: "/work?type=jobs", permanent: true },
    ];
  },
};

export default nextConfig;
