/**
 * Simulated outbound SMS for test environments with no SMS provider.
 *
 * A contractor action (today: an invoice's "Simulate send") can be recorded
 * as if it went through the normal outbound path - same contact, opt-out and
 * organization checks, same conversation thread - without contacting any
 * provider or phone. Allowed only when ALL hold:
 *
 *   1. a non-production deployment (the same rule "Simulate customer reply"
 *      uses: Vercel Preview/Development or a local non-production server;
 *      never Vercel Production or a self-hosted production build), and
 *   2. no SMS provider is configured here - with credentials present, a
 *      send is real and is never simulated, so the two can't be confused, and
 *   3. the caller asked for it explicitly (a separate action - the normal
 *      send never falls back to simulation).
 *
 * How it is stored (existing columns only): the message row gets status
 * 'logged' - never 'sent' or 'delivered' - a provider_message_id of
 * `sim_<uuid>` (the established simulated-record prefix, which no provider
 * callback can ever match) and SIMULATED_SMS_STATUS_REASON.
 */

/** Prefix that marks a stored message as simulated, never a real Twilio SID ("SM…"/"MM…"). */
export const SIMULATED_PROVIDER_MESSAGE_ID_PREFIX = "sim_";

/**
 * True only on a non-production deployment: a Vercel preview/development
 * build, or a local non-production server. Vercel Production - and any
 * self-hosted production build (NODE_ENV=production with no VERCEL_ENV) -
 * is always false. Shared by every simulation in messaging (this module
 * has no imports, so the outbound path can use it without pulling anything in).
 */
export function isMessagingSimulationEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development";
  return env.NODE_ENV !== "production";
}

export const SIMULATED_SMS_STATUS_REASON = "SIMULATED: no SMS was sent and no phone was contacted (test environment, SMS provider not configured).";

/** Mirrors sendSms's own configuration check: all three provider settings present. */
export function isSmsProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

export function canSimulateSmsDelivery(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMessagingSimulationEnvironment(env) && !isSmsProviderConfigured(env);
}

export function simulatedSmsProviderMessageId(uuid: string): string {
  return `${SIMULATED_PROVIDER_MESSAGE_ID_PREFIX}${uuid.toLowerCase()}`;
}

/** A stored message that was simulated, never sent. */
export function isSimulatedMessage(message: { provider_message_id: string | null | undefined }): boolean {
  return typeof message.provider_message_id === "string" && message.provider_message_id.startsWith(SIMULATED_PROVIDER_MESSAGE_ID_PREFIX);
}
