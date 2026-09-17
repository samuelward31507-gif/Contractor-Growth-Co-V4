export type SendSmsInput = {
  organizationId: string;
  to: string;
  body: string;
};

export type SendSmsResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; unconfigured: true };

/**
 * SMS provider boundary only. No SMS provider is configured anywhere in this
 * repository or environment yet, so this always returns a typed
 * "unconfigured" failure rather than pretending a message was sent - callers
 * must treat that as a real delivery failure, never as success. When a real
 * provider (Twilio, etc.) is chosen, only this function's body should need
 * to change; its signature is already shaped for a real send.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- input is part of the boundary's shape; unused until a real provider is wired in
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  return {
    ok: false,
    error: "SMS delivery is not configured for this environment.",
    unconfigured: true,
  };
}
