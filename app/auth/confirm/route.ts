import { type EmailOtpType, type SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";

// Handler for Supabase's email confirmation link. Supabase's Free-tier
// locked default {{ .ConfirmationURL }} template routes through Supabase's
// own hosted /verify endpoint, which - because @supabase/ssr defaults every
// client to PKCE flow - redirects back here with a `code` query parameter,
// never a `token_hash`. A customized email template (requires custom SMTP,
// not available on the Free tier) would instead send `token_hash` + `type`
// directly - that original path is preserved below unchanged, so this route
// keeps working unmodified the day custom SMTP is ever enabled.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  const supabase = await createClient();

  if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!error && data.user) {
      return redirectAfterConfirmation(supabase, data.user.id, type === "recovery");
    }
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    // exchangeCodeForSession's public AuthTokenResponse type doesn't declare
    // `redirectType`, but the installed SDK (@supabase/auth-js) attaches it
    // to the returned data at runtime - it's the exact same signal the SDK
    // itself uses internally to choose between firing PASSWORD_RECOVERY and
    // SIGNED_IN (see GoTrueClient's _exchangeCodeForSession, which reads it
    // back out of the stored PKCE verifier entry created when
    // resetPasswordForEmail/signUp first ran). This is the only reliable way
    // to distinguish a recovery code exchange from a signup-confirmation
    // code exchange under PKCE - the `code` value itself carries no such
    // signal, and neither request ever logs `code` or session values.
    const redirectType = (data as { redirectType?: string | null } | null)?.redirectType;

    if (!error && data.user) {
      return redirectAfterConfirmation(supabase, data.user.id, redirectType === "recovery");
    }
  }

  redirect("/login?error=confirmation_failed");
}

/**
 * Password recovery establishes a real session, exactly like signup
 * confirmation does - but the user hasn't set a new password yet, so this
 * must never fall through to the dashboard/onboarding redirect. Shared by
 * both verification paths above so the destination logic exists exactly
 * once, never duplicated between them. Function declaration (not a const
 * arrow function) so it's hoisted and callable from GET above regardless of
 * its own position in the file.
 */
async function redirectAfterConfirmation(supabase: SupabaseClient, userId: string, isRecovery: boolean): Promise<never> {
  if (isRecovery) {
    redirect("/auth/reset-password");
  }

  const membership = await getUserOrganization(supabase, userId);
  redirect(membership ? "/dashboard" : "/onboarding");
}
