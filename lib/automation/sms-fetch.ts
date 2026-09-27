import Twilio from "twilio";

/**
 * Trackpr Phase 5D-4 - the one place this codebase fetches an already-sent
 * or already-received Twilio Message resource (as opposed to lib/automation/
 * sms.ts's sendSms(), which only ever creates one). Kept as its own small
 * module, separate from sendSms(), so lib/costs/sms-cost-events.ts's cost
 * engine has one narrow, injectable seam to mock in tests - mirrors
 * lib/automation/sms.ts's own sendSmsFn test-seam convention exactly.
 *
 * Reuses the exact same TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN already
 * configured for sending - no new credential is introduced. Reads them
 * fresh on every call (no module-level client caching), matching sendSms()'s
 * own discipline.
 */

export type FetchedTwilioMessage = {
  /** Twilio's raw price string - typically a negative decimal (a debit), or null/empty if not yet finalized. Never parsed here; lib/costs/sms-cost-events.ts owns that. */
  price: string | null;
  priceUnit: string | null;
  numSegments: string | null;
  numMedia: string | null;
  status: string;
  dateSent: Date | null;
  dateCreated: Date | null;
  /** Twilio's own more granular direction ('inbound' | 'outbound-api' | 'outbound-call' | 'outbound-reply') - preserved for metadata only; the cost ledger's own `direction` column uses Trackpr's simpler messages.direction vocabulary instead. */
  direction: string | null;
};

export type FetchTwilioMessageResult = { ok: true; message: FetchedTwilioMessage } | { ok: false; error: string };

/**
 * Never throws: any missing config or provider error resolves to a typed
 * `{ ok: false }` result, matching sendSms()'s own fail-closed contract.
 * Never logs the credential values or message body - only a generic error
 * string and (server-side only) Twilio's numeric error code, neither of
 * which is secret.
 */
export async function fetchTwilioMessage(providerMessageId: string): Promise<FetchTwilioMessageResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return { ok: false, error: "Twilio is not configured for this environment." };
  }

  const client = Twilio(accountSid, authToken);

  try {
    const message = await client.messages(providerMessageId).fetch();
    // The installed Twilio SDK's own .d.ts declares price/priceUnit/
    // dateSent/dateCreated/numSegments/numMedia/direction as non-nullable
    // strings/Dates - but Twilio's actual REST API documents (and returns)
    // null for several of these before the resource is finalized (price
    // most notably - see this file's own header comment). Cast rather than
    // trust the SDK's optimistic type here, matching this codebase's
    // standing "never assume, always check the real shape" discipline.
    return {
      ok: true,
      message: {
        price: (message.price as string | null) ?? null,
        priceUnit: (message.priceUnit as string | null) ?? null,
        numSegments: (message.numSegments as string | null) ?? null,
        numMedia: (message.numMedia as string | null) ?? null,
        status: message.status,
        dateSent: (message.dateSent as Date | null) ?? null,
        dateCreated: (message.dateCreated as Date | null) ?? null,
        direction: (message.direction as string | null) ?? null,
      },
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { ok: false, error: `Twilio message fetch failed${code !== undefined ? ` (code ${code})` : ""}` };
  }
}
