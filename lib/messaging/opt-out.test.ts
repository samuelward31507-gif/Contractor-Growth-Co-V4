/**
 * Phase 3F: writeSmsOptOut - the STOP/START contacts.sms_opt_out write used
 * by the inbound SMS webhook. Offline: a scripted fake client, no network,
 * no database, no local environment file.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/opt-out.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { writeSmsOptOut }: typeof import("./opt-out") = require(path.join(process.cwd(), "lib/messaging/opt-out.ts"));

type Outcome = { data: { id: string }[] | null; error: { code?: string; message: string; details?: string; hint?: string } | null } | "throw";

/** Each update attempt consumes the next scripted outcome; records every call. */
function fakeService(outcomes: Outcome[]) {
  const calls: { table: string; update: unknown; eq: [string, unknown]; select: string }[] = [];
  const supabase = {
    from(table: string) {
      return {
        update(update: unknown) {
          return {
            eq(column: string, value: unknown) {
              return {
                async select(columns: string) {
                  calls.push({ table, update, eq: [column, value], select: columns });
                  const outcome = outcomes.shift();
                  if (outcome === undefined) throw new Error("unexpected extra attempt");
                  if (outcome === "throw") throw new Error("network down");
                  return outcome;
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

const OK: Outcome = { data: [{ id: "contact-1" }], error: null };
const DB_ERROR: Outcome = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout", details: "Key (phone)=(+15555550100)", hint: "secret hint" } };

test("STOP: succeeds on the first attempt - one write of sms_opt_out = true to the contact, with .select('id')", async () => {
  const { supabase, calls } = fakeService([OK]);
  assert.deepEqual(await writeSmsOptOut(supabase, "contact-1", true), { ok: true, attempts: 1 });
  assert.deepEqual(calls, [{ table: "contacts", update: { sms_opt_out: true }, eq: ["id", "contact-1"], select: "id" }]);
});

test("STOP: a database error on the first attempt, then success on the retry", async () => {
  const { supabase, calls } = fakeService([DB_ERROR, OK]);
  assert.deepEqual(await writeSmsOptOut(supabase, "contact-1", true), { ok: true, attempts: 2 });
  assert.equal(calls.length, 2);
});

test("START: writes sms_opt_out = false; a thrown exception then success on the retry", async () => {
  const { supabase, calls } = fakeService(["throw", OK]);
  assert.deepEqual(await writeSmsOptOut(supabase, "contact-1", false), { ok: true, attempts: 2 });
  assert.deepEqual(calls.map((c) => c.update), [{ sms_opt_out: false }, { sms_opt_out: false }]);
});

test("zero updated rows counts as a failure (and is retried)", async () => {
  const { supabase, calls } = fakeService([{ data: [], error: null }, { data: null, error: null }]);
  const result = await writeSmsOptOut(supabase, "contact-1", true);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
});

test("retries exactly once - never more than two attempts - and the failure carries only code and message (no details/hint)", async () => {
  const { supabase, calls } = fakeService([DB_ERROR, DB_ERROR, OK]);
  const result = await writeSmsOptOut(supabase, "contact-1", true);
  assert.equal(calls.length, 2, "a third attempt never happens");
  assert.deepEqual(result, { ok: false, attempts: 2, failure: { code: "57014", message: "canceling statement due to statement timeout" } });
  assert.doesNotMatch(JSON.stringify(result), /\+1555|secret hint|details|hint/);
});

test("two thrown exceptions: failure with a null code", async () => {
  const { supabase } = fakeService(["throw", "throw"]);
  assert.deepEqual(await writeSmsOptOut(supabase, "contact-1", false), { ok: false, attempts: 2, failure: { code: null, message: "network down" } });
});
