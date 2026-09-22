import AuthLayout from "@/app/(auth)/layout";
import { ResetPasswordForm } from "./reset-password-form";

// Lives under app/auth (not the app/(auth) route group) so its pathname
// starts with /auth - the one prefix lib/supabase/middleware.ts already
// exempts unconditionally, exactly like app/auth/confirm. Reusing the
// (auth) route group's own layout component directly (not duplicating its
// markup) guarantees the identical visual shell login/signup already use,
// with zero redesign.
export default function ResetPasswordPage() {
  return (
    <AuthLayout>
      <ResetPasswordForm />
    </AuthLayout>
  );
}
