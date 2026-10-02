import type { SupabaseClient } from "@supabase/supabase-js";

export type SmsOptOutWriteFailure = { code: string | null; message: string };

export type SmsOptOutWriteResult = { ok: true; attempts: number } | { ok: false; attempts: number; failure: SmsOptOutWriteFailure };

/** One initial write plus exactly one retry. */
const MAX_ATTEMPTS = 2;

async function writeOnce(service: SupabaseClient, contactId: string, smsOptOut: boolean): Promise<SmsOptOutWriteFailure | null> {
  try {
    const { data, error } = await service.from("contacts").update({ sms_opt_out: smsOptOut }).eq("id", contactId).select("id");
    if (error) return { code: error.code ?? null, message: error.message };
    if (!data || data.length === 0) return { code: null, message: "No contact row was updated." };
    return null;
  } catch (error) {
    return { code: null, message: error instanceof Error ? error.message : "Unexpected error." };
  }
}

/**
 * Phase 3F: persists a STOP (true) or START (false) to contacts.sms_opt_out
 * for the inbound SMS webhook (app/api/webhooks/sms/inbound/route.ts).
 * A database error, a thrown exception or zero updated rows all count as a
 * failed write, so a lost opt-out can never read as success. The write sets
 * a fixed boolean on a known row, so it is idempotent and safe to retry -
 * it is retried exactly once.
 *
 * The failure carries only the database error's code and message (never
 * its details/hint, which can echo row values), so the caller can log it
 * without exposing phone numbers or message content.
 */
export async function writeSmsOptOut(service: SupabaseClient, contactId: string, smsOptOut: boolean): Promise<SmsOptOutWriteResult> {
  let failure: SmsOptOutWriteFailure | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    failure = await writeOnce(service, contactId, smsOptOut);
    if (!failure) return { ok: true, attempts: attempt };
  }
  return { ok: false, attempts: MAX_ATTEMPTS, failure: failure! };
}
