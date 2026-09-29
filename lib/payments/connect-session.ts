import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import type { ConnectRouteSession } from "./connect-routes";

/**
 * Phase 1C, Step 4: resolves the Connect routes' caller exactly the way every
 * other organization-scoped route and action does (see
 * app/api/calendar/oauth/start/route.ts): the cookie session's user, then
 * that user's own organization_members row. Kept apart from
 * connect-routes.ts so the handlers stay free of next/headers and can be
 * unit-tested with a fake session.
 */
export async function resolveConnectSession(): Promise<ConnectRouteSession> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "unauthenticated" };

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) return { kind: "no_organization" };

  return { kind: "member", organizationId: membership.organizationId, role: membership.role, paymentStatus: membership.paymentStatus };
}
