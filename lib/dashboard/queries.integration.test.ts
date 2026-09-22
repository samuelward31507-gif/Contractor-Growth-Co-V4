/**
 * Integration tests for Growth System Completion Pass 2, Part 11: the owner's
 * own dashboard "Needs Attention" panel gains real visibility into a broken
 * Google Calendar sync (lib/dashboard/queries.ts's getDashboardData) - a
 * signal that, before this pass, only the agency admin could see (see
 * lib/agency/health.ts's own loadCalendarHealth for the identical
 * connected/error/not_connected distinction this reuses).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getDashboardData }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/dashboard/queries.ts"));

const service = createServiceRoleClient();

let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. no calendar connection at all is never an attention item - a normal, common state", async () => {
  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);
});

test("2. a healthy, connected calendar is never an attention item", async () => {
  await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "connected" });

  const data = await getDashboardData(service, organizationId);
  assert.equal(data.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);

  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
});

test("3. a calendar in an error state is surfaced as a real, actionable attention item with the real error detail", async () => {
  await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "error", last_error: "Refresh token expired" });

  const data = await getDashboardData(service, organizationId);
  const item = data.attentionItems.find((i) => i.kind === "calendar_disconnected");
  assert.ok(item, "an error-status calendar connection must appear in attentionItems");
  assert.equal(item!.detail, "Refresh token expired");

  await service.from("calendar_connections").delete().eq("organization_id", organizationId);
});

test("4. organization isolation: organization A's broken calendar never appears for organization B", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Dashboard Attention Test Org (Other)" }).select("id").single();
  try {
    await service.from("calendar_connections").insert({ organization_id: organizationId, provider: "google", status: "error", last_error: "Broken" });

    const dataOther = await getDashboardData(service, otherOrg!.id);
    assert.equal(dataOther.attentionItems.some((item) => item.kind === "calendar_disconnected"), false);

    await service.from("calendar_connections").delete().eq("organization_id", organizationId);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});
