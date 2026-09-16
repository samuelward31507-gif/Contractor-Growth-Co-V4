import { errorBannerClass } from "@/lib/ui/form";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const confirmationFailed = params.error === "confirmation_failed";

  return (
    <div className="space-y-6">
      {confirmationFailed ? (
        <p className={errorBannerClass}>
          That confirmation link is invalid or has expired. Please sign in, or
          sign up again to request a new one.
        </p>
      ) : null}
      <LoginForm />
    </div>
  );
}
