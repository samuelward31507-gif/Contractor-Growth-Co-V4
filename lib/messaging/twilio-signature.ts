import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio's request-signing scheme: HMAC-SHA1 of the full request URL with
 * every POST param (sorted by key, key+value concatenated with no
 * separator) appended, base64-encoded, compared to X-Twilio-Signature.
 * https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Extracted from app/api/webhooks/sms/inbound/route.ts (the original,
 * only-ever caller) so every Twilio webhook this codebase adds - the
 * inbound message route and the delivery-status callback route - shares
 * exactly one implementation. Never re-implement this algorithm a second
 * time in a new route.
 */
export function isValidTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
