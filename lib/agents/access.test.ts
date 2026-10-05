/**
 * Agent Operating Layer: who may open the internal Command Center, and the
 * contractor navigation never offering it. Pure: no network, no database -
 * the session and the is_agency_admin() answer are supplied as fakes.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/access.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { resolveCommandCenterAccess, parseAgentView }: typeof import("./access") = require(path.join(ROOT, "lib/agents/access.ts"));
const { getNavGroupsForVertical }: typeof import("../../app/(app)/_components/nav-items") = require(path.join(ROOT, "app/(app)/_components/nav-items.ts"));
const { isAgencyAdmin }: typeof import("../agency/queries") = require(path.join(ROOT, "lib/agency/queries.ts"));

const user = { id: "u1" } as import("@supabase/supabase-js").User;
const membership = { organizationId: "org-1", organizationName: "Acme", role: "owner", paymentStatus: "active", vertical: "contractor" } as const;

/** A fake Supabase session client: just enough for the real isAgencyAdmin() (auth.getUser + rpc("is_agency_admin")). */
function fakeSupabase(answer: { user: boolean; rpc: { data: unknown; error: unknown } | "throw" }) {
  const rpcCalls: string[] = [];
  return {
    rpcCalls,
    client: {
      auth: { getUser: async () => ({ data: { user: answer.user ? user : null } }) },
      rpc: async (name: string) => {
        rpcCalls.push(name);
        if (answer.rpc === "throw") throw new Error("network");
        return answer.rpc;
      },
    } as never,
  };
}

const access = (sb: ReturnType<typeof fakeSupabase>, m: typeof membership | null = membership, signedIn = true) =>
  resolveCommandCenterAccess({ getMembership: async () => ({ user: signedIn ? user : null, membership: m }), isAgencyAdmin: () => isAgencyAdmin(sb.client) });

test("a contractor (signed in, not an agency admin) is denied - through the real is_agency_admin() RPC", async () => {
  const sb = fakeSupabase({ user: true, rpc: { data: false, error: null } });
  assert.deepEqual(await access(sb), { kind: "denied" });
  assert.deepEqual(sb.rpcCalls, ["is_agency_admin"]);
});

test("a contractor with no organization is still denied, not sent into onboarding first", async () => {
  assert.deepEqual(await access(fakeSupabase({ user: true, rpc: { data: false, error: null } }), null), { kind: "denied" });
});

test("the admin check fails closed: RPC error, a non-boolean answer, or a throw all deny", async () => {
  assert.deepEqual(await access(fakeSupabase({ user: true, rpc: { data: null, error: { message: "boom" } } })), { kind: "denied" });
  assert.deepEqual(await access(fakeSupabase({ user: true, rpc: { data: "true", error: null } })), { kind: "denied" });
  assert.deepEqual(await access(fakeSupabase({ user: true, rpc: "throw" })), { kind: "denied" });
  assert.deepEqual(await access(fakeSupabase({ user: false, rpc: { data: true, error: null } })), { kind: "denied" }, "an unverified session is never an admin");
});

test("not signed in is unauthenticated; the admin RPC is never called", async () => {
  const sb = fakeSupabase({ user: false, rpc: { data: true, error: null } });
  assert.deepEqual(await access(sb, membership, false), { kind: "unauthenticated" });
  assert.deepEqual(sb.rpcCalls, []);
});

test("an agency admin is granted, scoped to their own verified membership", async () => {
  const result = await access(fakeSupabase({ user: true, rpc: { data: true, error: null } }));
  assert.equal(result.kind, "granted");
  assert.equal(result.kind === "granted" && result.membership.organizationId, "org-1");
  assert.deepEqual(await access(fakeSupabase({ user: true, rpc: { data: true, error: null } }), null), { kind: "no_membership" });
});

test("the drill-down parameter only ever names a specialist", () => {
  for (const id of ["sales", "trackpr_intelligence", "qa_health", "engineering", "market_intelligence", "prospecting"]) assert.equal(parseAgentView(id), id);
  for (const bad of [undefined, "", "chief_of_staff", "SALES", "org-1", ["sales"], "../agency", "sales&organizationId=x"]) assert.equal(parseAgentView(bad), null, String(bad));
});

test("no contractor navigation offers Intelligence or the Command Center", () => {
  for (const vertical of ["contractor", "gym"] as const) {
    for (const showAgencyLink of [false, true]) {
      const items = getNavGroupsForVertical(vertical, showAgencyLink).flatMap((g) => g.items);
      assert.equal(items.some((i) => i.href.startsWith("/insights/intelligence") || /intelligence/i.test(i.label)), false, `${vertical}/${showAgencyLink}`);
    }
  }
  // Nor any other contractor-shell source.
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.") ? [path.join(dir, e.name)] : []));
  const mentions = walk("app/(app)").filter((file) => fs.readFileSync(path.join(ROOT, file), "utf8").includes("/insights/intelligence"));
  assert.deepEqual(mentions, []);
});

test("the only navigation entry is in the Agency sidebar", () => {
  const sidebar = fs.readFileSync(path.join(ROOT, "app/agency/_components/agency-sidebar-content.tsx"), "utf8");
  assert.match(sidebar, /\{ href: "\/insights\/intelligence", label: "Intelligence", icon: Radar \}/);
});
