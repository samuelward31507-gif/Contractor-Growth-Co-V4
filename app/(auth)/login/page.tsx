import type { Metadata } from "next";
import { AuthError } from "../_components/auth-ui";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Trackpr",
  description: "Sign in to Trackpr, the revenue operating system from Cinder Revenue Company.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const confirmationFailed = params.error === "confirmation_failed";

  return (
    <LoginForm
      notice={
        confirmationFailed ? (
          <AuthError>That confirmation link is invalid or has expired. Please sign in, or sign up again to request a new one.</AuthError>
        ) : null
      }
    />
  );
}
