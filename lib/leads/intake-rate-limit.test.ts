/**
 * Final Batch 2: the lead-capture endpoint's per-source / per-phone /
 * organization-wide request limits (lib/leads/intake-rate-limit.ts).
 *
 * Runs the REAL limiter against an in-memory audit_log that supports the
 * jsonb `metadata->>key` filters the limiter uses, with fault injection for
 * the fail-closed cases. Nothing reaches TEST or Production.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/leads/intake-rate-limit.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_RATE_LIMITS,
  LEAD_CAPTURE_REQUEST_ACTION,
  checkAndRecordIntakeRequest,
  intakeRateKey,
  intakeSourceIp,
} from "./intake-rate-limit";

type Row = Record<string, unknown>;
const ORG = "org-1";
const OTHER_ORG = "org-2";

let rows: Row[] = [];
let now = Date.UTC(2026, 9, 5, 12, 0, 0);
const faults = { count: false, countThrows: false, insert: false, countNull: false };

function read(row: Row, column: string): unknown {
  const [base, key] = column.split("->>");
  if (key === undefined) return row[base];
  const value = row[base] as Row | undefined;
  return value?.[key];
}

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private insertRow: Row | null = null;
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => read(row, column) === value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  insert(row: Row) { this.insertRow = row; return this; }
  then<T>(resolve: (value: { data: unknown; error: unknown; count?: number | null }) => T, reject?: (reason: unknown) => T) {
    return this.run().then(resolve, reject);
  }
  private async run(): Promise<{ data: unknown; error: unknown; count?: number | null }> {
    if (this.insertRow) {
      if (faults.insert) return { data: null, error: { message: "insert failed" } };
      rows.push({ id: `row-${rows.length + 1}`, created_at: new Date(now).toISOString(), ...this.insertRow });
      return { data: null, error: null };
    }
    if (faults.countThrows) throw new Error("network down");
    if (faults.count) return { data: null, error: { message: "statement timeout" }, count: null };
    if (faults.countNull) return { data: null, error: null, count: null };
    return { data: null, error: null, count: rows.filter((row) => this.filters.every((f) => f(row))).length };
  }
}
const service = { from: () => new Query() } as never;

const check = (sourceIp: string, phone: string | null = null, organizationId = ORG) =>
  checkAndRecordIntakeRequest(service, { organizationId, sourceIp, phone, now: new Date(now) });

beforeEach(() => {
  rows = [];
  now = Date.UTC(2026, 9, 5, 12, 0, 0);
  faults.count = false;
  faults.countThrows = false;
  faults.insert = false;
  faults.countNull = false;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-real-key";
});

test("under the limit: every request from one source up to the limit is allowed and recorded", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max; i++) {
    assert.deepEqual(await check("203.0.113.7"), { ok: true });
  }
  assert.equal(rows.length, INTAKE_RATE_LIMITS.source.max);
  assert.ok(rows.every((row) => row.action === LEAD_CAPTURE_REQUEST_ACTION && row.organization_id === ORG && row.user_id === null));
});

test("over the limit: the next request from that source is refused (429, source scope)", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max; i++) await check("203.0.113.7");
  assert.deepEqual(await check("203.0.113.7"), { ok: false, status: 429, scope: "source" });
});

test("repeated requests stay blocked, and a refused request records nothing (a flood never grows the table)", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max; i++) await check("203.0.113.7");
  const before = rows.length;
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(await check("203.0.113.7"), { ok: false, status: 429, scope: "source" });
  }
  assert.equal(rows.length, before);
});

test("the window expires: once it has passed, the same source is allowed again", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max; i++) await check("203.0.113.7");
  now += INTAKE_RATE_LIMITS.source.windowMinutes * 60_000 + 1;
  assert.deepEqual(await check("203.0.113.7"), { ok: true });
});

test("independent sources are not collapsed: a blocked IP never blocks a different IP", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max + 3; i++) await check("203.0.113.7");
  assert.deepEqual(await check("198.51.100.20"), { ok: true });
  assert.deepEqual(await check("2001:db8::1"), { ok: true });
});

test("independent organizations are not collapsed: one org's flood never limits another org", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max + 3; i++) await check("203.0.113.7");
  assert.deepEqual(await check("203.0.113.7", null, OTHER_ORG), { ok: true });
});

test("per-phone: one number submitted from many IPs is capped (429, phone scope); a different number is not", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.phone.max; i++) {
    assert.deepEqual(await check(`203.0.113.${i + 1}`, "+15557770001"), { ok: true });
  }
  assert.deepEqual(await check("203.0.113.200", "+15557770001"), { ok: false, status: 429, scope: "phone" });
  assert.deepEqual(await check("203.0.113.201", "+15557770002"), { ok: true });
});

test("organization-wide backstop: a flood spread over many IPs is capped (429, organization scope)", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.organization.max; i++) {
    assert.deepEqual(await check(`10.0.${Math.floor(i / 200)}.${i % 200}`), { ok: true });
  }
  assert.deepEqual(await check("192.0.2.99"), { ok: false, status: 429, scope: "organization" });
});

test("concurrent requests that all pass the first check cannot together exceed the limit (post-insert re-check)", async () => {
  for (let i = 0; i < INTAKE_RATE_LIMITS.source.max - 1; i++) await check("203.0.113.7");
  const results = await Promise.all([check("203.0.113.7"), check("203.0.113.7"), check("203.0.113.7")]);
  const allowed = results.filter((r) => r.ok).length;
  assert.ok(allowed <= 1, `at most one of the racing requests may pass (got ${allowed})`);
  assert.ok(results.every((r) => r.ok || (r as { status: number }).status === 429));
});

for (const [label, fault] of [
  ["a count query error", "count"],
  ["a thrown count query", "countThrows"],
  ["a count that comes back missing", "countNull"],
  ["a failed request record", "insert"],
] as const) {
  test(`fails CLOSED on ${label} (503, never treated as under the limit)`, async () => {
    faults[fault] = true;
    assert.deepEqual(await check("203.0.113.7", "+15557770001"), { ok: false, status: 503, reason: "rate_limit_unavailable" });
  });
}

test("fails CLOSED when the hashing key is unavailable", async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.deepEqual(await check("203.0.113.7"), { ok: false, status: 503, reason: "rate_limit_unavailable" });
  assert.equal(rows.length, 0);
});

test("the request record holds only keyed hashes - never the raw IP or phone number", async () => {
  await check("203.0.113.7", "+15557770001");
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("203.0.113.7"));
  assert.ok(!serialized.includes("5557770001"));
  assert.deepEqual(Object.keys(rows[0].metadata as Row).sort(), ["ip_key", "phone_key"]);
  assert.match((rows[0].metadata as Row).ip_key as string, /^[0-9a-f]{32}$/);
  assert.equal((rows[0].metadata as Row).ip_key, intakeRateKey("ip", "203.0.113.7"));
  // Keyed: a different server key gives a different hash (an unkeyed hash of an IPv4 address is brute-forceable).
  process.env.SUPABASE_SERVICE_ROLE_KEY = "another-test-only-key";
  assert.notEqual(intakeRateKey("ip", "203.0.113.7"), (rows[0].metadata as Row).ip_key);
});

test("source IP: platform headers in priority order; anything that is not an IP falls back to one shared 'unknown' bucket", () => {
  assert.equal(intakeSourceIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.1" })), "203.0.113.7");
  assert.equal(intakeSourceIp(new Headers({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.1" })), "198.51.100.1");
  assert.equal(intakeSourceIp(new Headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1" })), "192.0.2.1");
  assert.equal(intakeSourceIp(new Headers({ "x-forwarded-for": "not-an-ip" })), "unknown");
  assert.equal(intakeSourceIp(new Headers()), "unknown");
});
