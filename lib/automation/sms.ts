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

  try {
    const message = await client.messages.create({ to, from: fromNumber, body: input.body });
    return { ok: true, providerMessageId: message.sid };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    console.error("[sms] Twilio send failed", { organizationId: input.organizationId, code });
    return { ok: false, error: "The SMS provider rejected the request." };
  }
}
