import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";

// Minimal handler for Supabase's email confirmation link. Supabase's default
// templates send `token_hash` + `type` (not an OAuth `code`), so this uses
// `verifyOtp` rather than `exchangeCodeForSession`.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && type) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!error && data.user) {
      // Password recovery establishes a real session, exactly like signup
      // confirmation does - but the user hasn't set a new password yet, so
      // this must never fall through to the dashboard/onboarding redirect
      // below. Every other EmailOtpType (signup confirmation, the only one
      // this app currently sends besides recovery) keeps its existing
      // behavior completely unchanged.
      if (type === "recovery") {
        redirect("/auth/reset-password");
      }

      const membership = await getUserOrganization(supabase, data.user.id);
      redirect(membership ? "/dashboard" : "/onboarding");
    }
  }

  redirect("/login?error=confirmation_failed");
}
