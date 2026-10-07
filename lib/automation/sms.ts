import Twilio from "twilio";
import { resolveAppBaseUrlFromEnv } from "@/lib/config/app-url";

export type SendSmsInput = {
  organizationId: string;
  to: string;
  body: string;
};

export type SendSmsResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; unconfigured?: true; providerErrorCode?: string };

// Loose E.164 shape check only (leading +, 2-15 digits, no leading zero) -
// not a full validation library. This never rewrites or "fixes" a number;
// it only decides whether to attempt a send at all, so an already-correct
// international number is never mangled. Exported so evaluateOutboundGate
// can apply the exact same check as a named, deterministic gate reason
// ("invalid_destination") before ever reaching this provider boundary,
// rather than only discovering an invalid number here, one layer later.
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

const STATUS_CALLBACK_PATH = "/api/webhooks/sms/status";

/**
 * Resolves Trackpr's own stable, public base URL - never a temporary
 * per-deployment preview URL, and never a guess. Final Batch 4: the rules
 * now live in lib/config/app-url.ts (one place; production can name its
 * canonical domain with APP_CANONICAL_URL, and otherwise keeps the
 * hard-coded fail-safe this function always returned). Unchanged contract:
 * null means "not configured yet" and callers degrade gracefully.
 */
export function resolveAppBaseUrl(): string | null {
  return resolveAppBaseUrlFromEnv(process.env);
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
    const providerErrorCode = providerErrorCodeFrom(error);
    return { ok: false, error: "The SMS provider rejected the request.", ...(providerErrorCode ? { providerErrorCode } : {}) };
  }
}

const MAX_PROVIDER_ERROR_CODE_LENGTH = 32;

/**
 * Twilio's error code (e.g. 21608, 21211) from a rejected messages.create,
 * as a trimmed string capped to messages.provider_error_code's 32-character
 * limit - or undefined when there is none. Only the code: Twilio's error
 * message can contain the destination number, so it is never kept.
 */
export function providerErrorCodeFrom(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "number" && typeof code !== "string") return undefined;
  const trimmed = String(code).trim();
  return trimmed ? trimmed.slice(0, MAX_PROVIDER_ERROR_CODE_LENGTH) : undefined;
}
