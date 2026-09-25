/**
 * Pass 2 (Native Calendar System): structural tests for the blocked-time
 * Server Actions (app/(app)/calendar/actions.ts). These call
 * cookies()-dependent requireOrganization()/createClient(), so - matching
 * this codebase's own established convention (see
 * app/(app)/appointments/actions.timezone.test.ts's own header comment) -
 * they can't be invoked directly from a bare node:test script; this file
 * verifies the real source instead, focused specifically on the security-
 * relevant property that every write is scoped to the caller's real
 * organization, never a client-supplied one.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/calendar/actions.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(app)/calendar/actions.ts"), "utf8");

function extractFunction(name: string): string {
  const match = SOURCE.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected to find ${name}`);
  return match![0];
}

test("1. every blocked-time action resolves the organization via requireOrganization() - never a client-supplied organization id", () => {
  for (const name of ["createBlockedTime", "updateBlockedTime", "deleteBlockedTime"]) {
    assert.match(extractFunction(name), /requireOrganization\(\)/, `expected ${name} to call requireOrganization()`);
  }
});

test("2. updateBlockedTime and deleteBlockedTime both scope their query by BOTH id AND organization_id - never id alone, which would let one org touch another org's row if RLS were ever bypassed", () => {
  for (const name of ["updateBlockedTime", "deleteBlockedTime"]) {
    const body = extractFunction(name);
    assert.match(body, /\.eq\("id", id\)/);
    assert.match(body, /\.eq\("organization_id", organizationId\)/);
  }
});

test("3. createBlockedTime and updateBlockedTime both convert wall-clock date/startTime/endTime via the existing zonedWallTimeToUtc - never a naive Date parse", () => {
  assert.match(SOURCE, /import \{ zonedWallTimeToUtc \} from "@\/lib\/scheduling\/availability";/);
  const matches = SOURCE.match(/zonedWallTimeToUtc\(/g) ?? [];
  assert.equal(matches.length, 2, "expected exactly two calls - one for startAt, one for endAt, inside the shared parseBlockedTimeForm helper");
});

test("4. the organization's real configured timezone is resolved before parsing the form - never a hardcoded zone", () => {
  for (const name of ["createBlockedTime", "updateBlockedTime"]) {
    const body = extractFunction(name);
    const timezoneIndex = body.indexOf("getOrganizationTimezone(");
    const parseIndex = body.indexOf("parseBlockedTimeForm(");
    assert.ok(timezoneIndex !== -1 && parseIndex !== -1);
    assert.ok(timezoneIndex < parseIndex, `${name} must resolve the organization timezone before parsing the form`);
  }
});

test("5. every write revalidates /calendar so the calendar reflects the change immediately", () => {
  for (const name of ["createBlockedTime", "updateBlockedTime", "deleteBlockedTime"]) {
    assert.match(extractFunction(name), /revalidatePath\("\/calendar"\)/);
  }
});

test("6. end time must be after start time is enforced before any write is attempted", () => {
  assert.match(SOURCE, /if \(endAt\.getTime\(\) <= startAt\.getTime\(\)\)/);
});
