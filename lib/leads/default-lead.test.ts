/**
 * Phase 2B: the LeadPicker's initial selection (lib/leads/default-lead.ts)
 * and how each dialog wires it - new estimates and jobs default to the
 * contact's newest open lead; existing records and appointments never guess.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/leads/default-lead.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { newestOpenLeadId, leadPickerDefault }: typeof import("./default-lead") = require(path.join(process.cwd(), "lib/leads/default-lead.ts"));

const lead = (id: string, status: string, created_at: string, contact_id = "c-1") => ({ id, contact_id, status, created_at }) as Parameters<typeof newestOpenLeadId>[0][number];
const LEADS = [
  lead("old-open", "new", "2026-08-01T00:00:00Z"),
  lead("newest-open", "estimate", "2026-09-10T00:00:00Z"),
  lead("newer-won", "won", "2026-09-20T00:00:00Z"),
  lead("newer-lost", "lost", "2026-09-21T00:00:00Z"),
  lead("other-contact", "new", "2026-09-25T00:00:00Z", "c-2"),
];
const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

test("a new estimate or job defaults to the contact's newest OPEN lead - closed leads and other contacts' leads are ignored", () => {
  assert.equal(newestOpenLeadId(LEADS, "c-1"), "newest-open");
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1", defaultToNewestOpenLead: true }), "newest-open");
});

test("no open lead → blank (No lead), never a closed or another contact's lead", () => {
  const closedOnly = [lead("won", "won", "2026-09-01T00:00:00Z"), lead("lost", "lost", "2026-09-02T00:00:00Z"), lead("x", "new", "2026-09-03T00:00:00Z", "c-2")];
  assert.equal(newestOpenLeadId(closedOnly, "c-1"), null);
  assert.equal(leadPickerDefault({ leads: closedOnly, contactId: "c-1", defaultToNewestOpenLead: true }), "");
  assert.equal(leadPickerDefault({ leads: [], contactId: "", defaultToNewestOpenLead: true }), "", "no contact chosen yet");
});

test("an existing record keeps its own link - including an explicit No lead - and is never re-guessed", () => {
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1", defaultLeadId: null, defaultToNewestOpenLead: true }), "");
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1", defaultLeadId: "old-open", defaultToNewestOpenLead: true }), "old-open");
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1", defaultLeadId: null }), "");
});

test("appointments (no opt-in) start on blank exactly as before", () => {
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1" }), "");
  assert.equal(leadPickerDefault({ leads: LEADS, contactId: "c-1", defaultLeadId: "old-open" }), "old-open");
});

test("wiring: estimate (new only) and job dialogs opt in and say \"No lead\"; appointments keep their call and their label", () => {
  const picker = read("app/(app)/appointments/_components/lead-picker.tsx");
  assert.match(picker, /defaultToNewestOpenLead = false/);
  assert.match(picker, /emptyLabel = "No lead \(general appointment\)"/);
  assert.match(picker, /<option value="">\{emptyLabel\}<\/option>/);
  assert.match(read("app/(app)/appointments/_components/appointment-dialog.tsx"), /<LeadPicker leads=\{leads\} contactId=\{contactId\} defaultLeadId=\{appointment\?\.lead_id\} \/>/);
  assert.match(read("app/(app)/estimates/_components/estimate-dialog.tsx"), /<LeadPicker leads=\{leads\} contactId=\{contactId\} defaultLeadId=\{estimate \? estimate\.lead_id : undefined\} defaultToNewestOpenLead=\{!estimate\} emptyLabel="No lead" \/>/);
  assert.match(read("app/(app)/jobs/_components/job-dialog.tsx"), /<LeadPicker leads=\{leads\} contactId=\{contactId\} defaultToNewestOpenLead emptyLabel="No lead" \/>/);
});

test("server: an explicit No lead (blank) is saved blank - estimates and manual jobs never fill it in", () => {
  const estimates = read("app/(app)/estimates/actions.ts");
  assert.match(estimates, /leadId: leadId \|\| null,/);
  const jobs = read("app/(app)/jobs/actions.ts");
  assert.match(jobs, /lead_id: leadId \|\| null,\s*estimate_id: null,/);
});
