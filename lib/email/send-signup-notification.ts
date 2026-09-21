import { Resend } from "resend";

/**
 * Internal-only notification sent to Contractor Growth Co. staff when a new
 * contractor creates a Trackpr account - entirely separate from the
 * customer's own Supabase confirmation email, which this module never
 * touches. Only ever imported from server-side code (this file, like every
 * other server-only module in this codebase - e.g. lib/supabase/service.ts -
 * relies on RESEND_API_KEY having no NEXT_PUBLIC_ prefix, which keeps it out
 * of the client bundle by Next.js's own build-time env handling, plus never
 * being imported from a "use client" component) so RESEND_API_KEY can never
 * reach the browser.
 */

const DEFAULT_RECIPIENT = "contractorgrowthcompany@gmail.com";

export type SignupNotificationInput = {
  /** The email address the customer signed up with. Never include a password or any other credential here. */
  email: string;
  userId: string;
  /** Defaults to now - only ever overridden by tests. */
  signupTime?: Date;
};

export type SignupNotificationEmail = {
  to: string;
  from: string;
  subject: string;
  text: string;
};

/**
 * Pure formatting - no network call, nothing that can throw for a
 * reachability reason - so it can be unit-tested directly and reused if the
 * subject/body ever needs to be previewed. Deliberately plain text: this is
 * an internal ops alert, not a branded customer email.
 */
export function buildSignupNotificationEmail(input: SignupNotificationInput): SignupNotificationEmail {
  const signupTime = (input.signupTime ?? new Date()).toISOString();

  const text = [
    "New signup received.",
    "",
    "Email:",
    input.email,
    "",
    "Signup time:",
    signupTime,
    "",
    "User ID:",
    input.userId,
    "",
    "Status:",
    "Account created — awaiting email confirmation",
    "",
    "Next step:",
    "Customer needs to confirm their email and complete onboarding.",
  ].join("\n");

  return {
    to: process.env.SIGNUP_NOTIFICATION_TO || DEFAULT_RECIPIENT,
    from: process.env.EMAIL_FROM ?? "",
    subject: "New Contractor Growth Co. Signup",
    text,
  };
}

/** The real network call, isolated behind this one function so tests can inject a fake instead of hitting Resend. */
async function sendViaResend(email: SignupNotificationEmail): Promise<{ error?: unknown }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { error: new Error("RESEND_API_KEY is not configured") };
  }
  const resend = new Resend(apiKey);
  const result = await resend.emails.send(email);
  return { error: result.error ?? undefined };
}

/**
 * Fire-and-log, never fire-and-throw: a broken or unconfigured notification
 * must never take down signup for the customer. Every failure path here
 * (missing config, a Resend API error, a thrown network error) is caught
 * and logged server-side only - nothing about it is ever surfaced to the
 * caller or the browser. Call this exactly once, only from the successful
 * branch of the signup server action, after Supabase has actually created
 * the account - never from client code, a redirect target, or a route the
 * browser could hit more than once for the same signup.
 */
export async function sendSignupNotification(
  input: SignupNotificationInput,
  deps: { send?: (email: SignupNotificationEmail) => Promise<{ error?: unknown }> } = {},
): Promise<void> {
  const email = buildSignupNotificationEmail(input);

  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.error(
      "[signup-notification] Skipped: RESEND_API_KEY and/or EMAIL_FROM is not configured. See README/deployment docs for setup.",
    );
    return;
  }

  const send = deps.send ?? sendViaResend;

  try {
    const { error } = await send(email);
    if (error) {
      console.error("[signup-notification] Resend returned an error while sending the internal signup notification:", error);
    }
  } catch (error) {
    console.error("[signup-notification] Failed to send the internal signup notification:", error);
  }
}
