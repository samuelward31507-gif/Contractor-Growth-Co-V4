/**
 * Final Batch 2: the organization's sending number (organizations.sms_phone_number)
 * can be changed only by an owner/admin of that same organization.
 *
 * Runs the REAL server actions (updateSmsPhoneNumber / clearSmsPhoneNumber)
 * and the REAL assertOrgAdmin against an in-memory session client whose
 * is_org_admin RPC and organizations UPDATE mirror the database: the update
 * applies only to rows the caller is an admin of (organizations_update RLS:
 * is_org_admin(id)). Nothing reaches TEST, Production or Twilio.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/settings/sms/actions.test.ts"
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG_A = "org-a";
const ORG_B = "org-b";

let organizations: Row[] = [];
let memberships: { user: string; org: string; role: "owner" | "admin" | "member" }[] = [];
let currentUser = "user-admin-a";
let auditCalls: Row[] = [];

const isAdmin = (user: string, org: string) => memberships.some((m) => m.user === user && m.org === org && (m.role === "owner" || m.role === "admin"));

class OrganizationsUpdate {
  private values: Row = {};
  private id: string | null = null;
  constructor(values: Row) {
    this.values = values;
  }
  eq(_column: "id", value: string) {
    this.id = value;
    return this;
  }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T) {
    // organizations_update RLS: using/with check is_org_admin(id) - a non-admin's update matches no row.
    const rows = organizations.filter((row) => row.id === this.id && isAdmin(currentUser, row.id as string));
    for (const row of rows) Object.assign(row, this.values);
    return Promise.resolve({ data: rows, error: null }).then(resolve);
  }
}

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
  rpc: async (name: string, args: Row) => {
    if (name === "is_org_admin") return { data: isAdmin(currentUser, args.target_org_id as string), error: null };
    if (name === "create_organization_audit_event") {
      auditCalls.push({ user: currentUser, ...args });
      return { data: null, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  },
  from: (table: string) => {
    assert.equal(table, "organizations");
    return { update: (values: Row) => new OrganizationsUpdate(values) };
  },
};

mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => sessionClient } });
mock.module(lib("lib/auth/organization.ts"), {
  namedExports: {
    // The caller's own organization from the session - never a client-supplied id.
    getUserOrganization: async (_s: unknown, userId: string) => {
      const membership = memberships.find((m) => m.user === userId);
      return membership ? { organizationId: membership.org, role: membership.role } : null;
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", {
  namedExports: {
    redirect: (to: string) => {
      throw new Error(`redirect:${to}`);
    },
  },
});

const { updateSmsPhoneNumber, clearSmsPhoneNumber } = await import(lib("app/(app)/settings/sms/actions.ts"));

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const numberOf = (org: string) => organizations.find((row) => row.id === org)!.sms_phone_number;

beforeEach(() => {
  organizations = [
    { id: ORG_A, sms_phone_number: "+15550001111" },
    { id: ORG_B, sms_phone_number: "+15550002222" },
  ];
  memberships = [
    { user: "user-owner-a", org: ORG_A, role: "owner" },
    { user: "user-admin-a", org: ORG_A, role: "admin" },
    { user: "user-member-a", org: ORG_A, role: "member" },
    { user: "user-admin-b", org: ORG_B, role: "admin" },
  ];
  currentUser = "user-admin-a";
  auditCalls = [];
});

const DENIED = { error: "You must be an owner or admin of this organization." };

test("admin: an admin changes its own organization's sending number, and it is audited", async () => {
  const result = await updateSmsPhoneNumber({}, form({ smsPhoneNumber: "+15550003333" }));
  assert.deepEqual(result, { success: true, auditWarning: undefined });
  assert.equal(numberOf(ORG_A), "+15550003333");
  assert.equal(numberOf(ORG_B), "+15550002222");
  assert.deepEqual(auditCalls, [{ user: "user-admin-a", p_organization_id: ORG_A, p_action: "organization_sms_number_updated", p_metadata: {} }]);
});

test("admin: an owner can change and clear it too", async () => {
  currentUser = "user-owner-a";
  assert.equal((await updateSmsPhoneNumber({}, form({ smsPhoneNumber: "+15550004444" }))).success, true);
  assert.equal(numberOf(ORG_A), "+15550004444");
  assert.equal((await clearSmsPhoneNumber({}, form({}))).success, true);
  assert.equal(numberOf(ORG_A), null);
});

test("non-admin: a member cannot change or clear the sending number; nothing is written or audited", async () => {
  currentUser = "user-member-a";
  assert.deepEqual(await updateSmsPhoneNumber({}, form({ smsPhoneNumber: "+15550003333" })), DENIED);
  assert.deepEqual(await clearSmsPhoneNumber({}, form({})), DENIED);
  assert.equal(numberOf(ORG_A), "+15550001111");
  assert.deepEqual(auditCalls, []);
});

test("cross-org: an admin of another organization cannot change this one - a client-supplied organization id is ignored", async () => {
  currentUser = "user-admin-b";
  const result = await updateSmsPhoneNumber({}, form({ smsPhoneNumber: "+15550005555", organizationId: ORG_A, organization_id: ORG_A }));
  assert.equal(result.success, true, "the action only ever acts on the caller's own organization");
  assert.equal(numberOf(ORG_A), "+15550001111", "organization A is untouched");
  assert.equal(numberOf(ORG_B), "+15550005555");
  assert.equal(auditCalls[0].p_organization_id, ORG_B);
  await clearSmsPhoneNumber({}, form({ organizationId: ORG_A }));
  assert.equal(numberOf(ORG_A), "+15550001111");
});

test("cross-org at the database: RLS (is_org_admin) refuses an update of an organization the caller does not administer", async () => {
  currentUser = "user-admin-b";
  const { data } = (await sessionClient.from("organizations").update({ sms_phone_number: "+15550006666" }).eq("id", ORG_A)) as { data: Row[] };
  assert.equal(data.length, 0);
  assert.equal(numberOf(ORG_A), "+15550001111");
});

test("signed out: redirected to login, nothing written", async () => {
  currentUser = "";
  await assert.rejects(() => updateSmsPhoneNumber({}, form({ smsPhoneNumber: "+15550003333" })), /redirect:\/login/);
  assert.equal(numberOf(ORG_A), "+15550001111");
});

test("an invalid number is rejected before any write", async () => {
  const result = await updateSmsPhoneNumber({}, form({ smsPhoneNumber: "not a number" }));
  assert.ok(result.error);
  assert.equal(numberOf(ORG_A), "+15550001111");
});
