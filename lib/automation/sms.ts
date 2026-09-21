import Twilio from "twilio";

export type SendSmsInput = {
  organizationId: string;
  to: string;
  body: string;
};

export type SendSmsResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; unconfigured?: true };

// Loose E.164 shape check only (leading +, 2-15 digits, no leading zero) -
// not a full validation library. This never rewrites or "fixes" a number;
// it only decides whether to attempt a send at all, so an already-correct
// international number is never mangled. Exported so evaluateOutboundGate
// can apply the exact same check as a named, deterministic gate reason
// ("invalid_destination") before ever reaching this provider boundary,
// rather than only discovering an invalid number here, one layer later.
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

const STATUS_CALLBACK_PATH = "/api/webhooks/sms/status";

// The single canonical production URL. `VERCEL_PROJECT_PRODUCTION_URL` is
// NOT reliably exposed to every Vercel Function (it depends on a project-level
// "Automatically expose System Environment Variables" setting) - a real
// 2026-09-21 production incident proved it absent at runtime here, which
// silently fell through to a request-header-based fallback that produced
// `http://localhost:3000` in a live Supabase confirmation email. `VERCEL_ENV`,
// by contrast, is unconditionally injected by Vercel on every request, so
// gating on it is the one deterministic, production-safe signal available.
const PRODUCTION_APP_URL = "https://contractor-growth-co-v4.vercel.app";

/**
 * Resolves Trackpr's own stable, public base URL - never a temporary
 * per-deployment preview URL, and never a guess. In production this is
 * always the hardcoded canonical URL above, regardless of any other env
 * var's availability. Outside production, `APP_BASE_URL` is an explicit
 * opt-in override (e.g. for a custom preview domain), checked first, then
 * `VERCEL_PROJECT_PRODUCTION_URL` where it happens to be exposed. Returns
 * null (not a guess) when none apply, e.g. running locally with no .env
 * override; callers must treat that as "not configured yet", the same
 * graceful-degradation shape sendSms() already uses for missing Twilio
 * credentials.
 */
export function resolveAppBaseUrl(): string | null {
  if (process.env.VERCEL_ENV === "production") return PRODUCTION_APP_URL;

  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProductionUrl) return `https://${vercelProductionUrl}`;

  return null;
}

export type TwilioCreateMessageParams = { to: string; from: string; body: string; statusCallback?: string };

/**
 * Pure builder for the exact params object passed to the Twilio SDK's
 * `messages.create()` - extracted so "does the outbound send actually
 * request delivery-status callbacks" is a fast, direct unit test rather
 * than something only provable by mocking the Twilio SDK itself.
 * statusCallback is omitted entirely (not sent as an empty string) when no
 * base URL is configured, matching Twilio's own API contract.
 */
export function buildTwilioCreateMessageParams(input: { to: string; from: string; body: string; statusCallbackUrl: string | null }): TwilioCreateMessageParams {
  const params: TwilioCreateMessageParams = { to: input.to, from: input.from, body: input.body };
  if (input.statusCallbackUrl) {
    params.statusCallback = input.statusCallbackUrl;
  }
  return params;
}

/**
 * SMS provider boundary. Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_FROM_NUMBER directly from the environment on every call - no
 * module-level client caching, so there is nothing about a prior call's
 * credentials to leak into a later one. Same TWILIO_AUTH_TOKEN variable the
 * inbound webhook (app/api/webhooks/sms/inbound) already uses to validate
 * Twilio's request signature - one credential, one env var name, read
 * independently by each boundary that needs it.
 *
 * Never throws: any missing config or provider error resolves to a typed
 * `{ ok: false }` result. Never logs or returns the credential values, the
 * destination number, or the message body - only a generic error string and
 * (server-side only) the organization id and Twilio's numeric error code,
 * neither of which is secret.
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return {
      ok: false,
      error: "SMS delivery is not configured for this environment.",
      unconfigured: true,
    };
  }

  const to = input.to.trim();
  if (!E164_PATTERN.test(to)) {
    return { ok: false, error: "The destination phone number is not a valid E.164 number." };
  }

  const client = Twilio(accountSid, authToken);
  const baseUrl = resolveAppBaseUrl();
  const statusCallbackUrl = baseUrl ? `${baseUrl}${STATUS_CALLBACK_PATH}` : null;

  try {
    const message = await client.messages.create(buildTwilioCreateMessageParams({ to, from: fromNumber, body: input.body, statusCallbackUrl }));
    return { ok: true, providerMessageId: message.sid };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    console.error("[sms] Twilio send failed", { organizationId: input.organizationId, code });
    return { ok: false, error: "The SMS provider rejected the request." };
  }
}
