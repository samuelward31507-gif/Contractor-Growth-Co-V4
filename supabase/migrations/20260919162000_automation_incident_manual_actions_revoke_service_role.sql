-- acknowledge_automation_incident/resolve_automation_incident were already
-- documented as "no service_role grant - this RPC has no legitimate
-- service-role caller", but that comment was inaccurate: Supabase's
-- schema-wide default privileges grant EXECUTE to service_role on every
-- newly created function automatically (confirmed via pg_default_acl on the
-- live project), so an explicit `revoke ... from anon` (already present in
-- the automation_health_and_alerting migration) does not also revoke
-- service_role's separately-granted default privilege. This was harmless in
-- practice - both functions require a non-null auth.uid() and immediately
-- raise 'Not authenticated' for a service_role caller (which has none) -
-- but the grant surface should match what that migration's own comment
-- claims, as explicit defense in depth rather than relying solely on the
-- internal auth check.
revoke all on function public.acknowledge_automation_incident(uuid) from service_role;
revoke all on function public.resolve_automation_incident(uuid) from service_role;
