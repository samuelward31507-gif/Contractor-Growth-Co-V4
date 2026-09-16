import type { AuthError } from "@supabase/supabase-js";

const FALLBACK_MESSAGE = "We couldn't complete that request. Please try again.";

/**
 * Translates a Supabase AuthError into a safe, user-facing message. Only a
 * known allowlist of error codes is ever surfaced verbatim in spirit - every
 * other code (including anything unexpected or server-side) falls back to a
 * generic message so internal details never reach the browser.
 */
export function mapAuthError(error: AuthError): string {
  switch (error.code) {
    case "invalid_credentials":
      return "The email or password you entered is incorrect.";
    case "email_not_confirmed":
      return "Please confirm your email address before signing in. Check your inbox for the confirmation link.";
    case "user_already_exists":
    case "email_exists":
    case "identity_already_exists":
      return "An account with this email already exists. Try signing in instead.";
    case "weak_password":
      return `That password is too weak. Please use at least 8 characters, mixing letters and numbers.`;
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Please wait a moment and try again.";
    case "user_banned":
      return "This account is not able to sign in. Please contact support.";
    default:
      return FALLBACK_MESSAGE;
  }
}
