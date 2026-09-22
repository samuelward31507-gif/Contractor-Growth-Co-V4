-- Launch Blocker #3: legal/consent infrastructure - minimal, additive.
--
-- Records that a contractor accepted the Terms of Service / acknowledged
-- the Privacy Policy, and which version of those documents they accepted.
-- Both columns are nullable with no default: every organization that
-- already exists today was created before this consent flow existed, so
-- backfilling a fabricated acceptance timestamp for them would misrepresent
-- what actually happened. New organizations populate both columns from
-- app/onboarding/actions.ts's createOrganization, at the same point the
-- rest of the Step 1 business-profile fields (owner_name/trade/phone) are
-- already written - see that file's own comments for why organization
-- creation, not the initial signup() call, is where the organizations row
-- first exists to write onto.
--
-- No RLS change is needed: both columns live on organizations, which
-- already has organizations_update (is_org_admin) allowing an org's own
-- owner/admin to update their own row's non-payment_status columns -
-- exactly the same policy owner_name/trade/phone already rely on. Neither
-- column is touched by the payment_gate_rls_enforcement or
-- payment_gate_rpc_enforcement migrations, and this migration does not
-- touch either of those.

alter table public.organizations
  add column if not exists terms_accepted_at timestamptz;

alter table public.organizations
  add column if not exists terms_version text;
