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
      const membership = await getUserOrganization(supabase, data.user.id);
      redirect(membership ? "/dashboard" : "/onboarding");
    }
  }

  redirect("/login?error=confirmation_failed");
}
