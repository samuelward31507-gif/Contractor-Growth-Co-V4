/**
 * Final Batch 3: the People Leads view shows every open lead, not only hot ones.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/people/filter.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPeople } from "./filter";
import type { LeadTemperature } from "@/lib/leads/queries";

const people = [{ id: "hot" }, { id: "warm" }, { id: "cold" }, { id: "no-open-lead" }];
const temperatures = new Map<string, LeadTemperature>([
  ["hot", "hot"],
  ["warm", "warm"],
  ["cold", "cold"],
]);
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

test("the Leads view shows every open lead - warm and cold included, not only hot", () => {
  assert.deepEqual(ids(filterPeople(people, temperatures, { view: "leads", temperature: "all" })), ["hot", "warm", "cold"]);
});

test("hot leads remain accessible (view + temperature, and the old temperature-only link)", () => {
  assert.deepEqual(ids(filterPeople(people, temperatures, { view: "leads", temperature: "hot" })), ["hot"]);
  assert.deepEqual(ids(filterPeople(people, temperatures, { view: "all", temperature: "hot" })), ["hot"]);
  assert.deepEqual(ids(filterPeople(people, temperatures, { view: "leads", temperature: "cold" })), ["cold"]);
});

test("Contacts (no view, no temperature) is everyone, including people with no open lead", () => {
  assert.deepEqual(ids(filterPeople(people, temperatures, { view: "all", temperature: "all" })), ["hot", "warm", "cold", "no-open-lead"]);
});

test("filtering never changes the underlying data", () => {
  const rows = people.map((row) => ({ ...row }));
  const snapshot = JSON.stringify(rows);
  const map = new Map(temperatures);
  filterPeople(rows, map, { view: "leads", temperature: "warm" });
  assert.equal(JSON.stringify(rows), snapshot);
  assert.deepEqual([...map.entries()], [...temperatures.entries()]);
});

test("the Leads nav entry, Today's Leads card and the /leads redirect all land on the full Leads view", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync("app/(app)/_components/nav-items.ts", "utf8"), /href: "\/people\?view=leads", label: "Leads"/);
  assert.match(readFileSync("app/(app)/today/_components/dashboard-model.ts", "utf8"), /label: "Leads", value: values\.openLeads, detail: `\$\{summary\.hot_lead_count\} hot`, href: "\/people\?view=leads"/);
  assert.match(readFileSync("next.config.ts", "utf8"), /source: "\/leads", destination: "\/people\?view=leads"/);
  assert.match(readFileSync("app/(app)/people/page.tsx", "utf8"), /filterPeople\(allContacts, temperatureByContactId, \{ view, temperature \}\)/);
});
