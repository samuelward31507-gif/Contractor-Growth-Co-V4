/**
 * Phase 2-13 structural tests for the Person and contact pages, verified
 * against the real source files (the ui.structural.test.ts convention):
 *   D3  - opportunity types render through the shared registry label, never
 *         a page-local map or a raw type code;
 *   §3  - every next-step caller passes the conversations waiting on the
 *         business (lib/conversations/waiting), never the AI-off rule.
 *
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/people/person-pages.structural.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const { OPPORTUNITY_TYPE_LABEL }: typeof import("@/lib/decisions/registry") = require(path.join(ROOT, "lib/decisions/registry.ts"));
const { OPPORTUNITY_VALUE_CLASS }: typeof import("@/lib/opportunities/queries") = require(path.join(ROOT, "lib/opportunities/queries.ts"));

const PERSON_PAGES = ["app/(app)/people/[id]/page.tsx", "app/(app)/contacts/[id]/page.tsx"];

test("D3: the Person and contact pages label opportunity types from the shared registry - no local map, no raw-code fallback", () => {
  for (const file of PERSON_PAGES) {
    const source = read(file);
    assert.match(source, /import \{ OPPORTUNITY_TYPE_LABEL \} from "@\/lib\/decisions\/registry";/, file);
    assert.doesNotMatch(source, /OPPORTUNITY_TYPE_LABELS/, `${file}: no page-local label map`);
    assert.doesNotMatch(source, /OPPORTUNITY_TYPE_LABEL\[[^\]]+\] \?\? /, `${file}: no fallback to the raw type code`);
  }
});

test("D3: the registry has a human label for every opportunity type", () => {
  for (const type of Object.keys(OPPORTUNITY_VALUE_CLASS)) {
    const label = OPPORTUNITY_TYPE_LABEL[type as keyof typeof OPPORTUNITY_TYPE_LABEL];
    assert.ok(label && label.length > 0 && !label.includes("_"), `${type} -> ${label}`);
  }
});

test("§3: every next-step caller passes the conversations waiting on the business", () => {
  for (const file of ["app/(app)/people/[id]/page.tsx", "app/(app)/people/page.tsx", "app/(app)/appointments/[id]/page.tsx", "app/(app)/conversations/[id]/page.tsx"]) {
    const source = read(file);
    assert.match(source, /getWaitingConversationIds\(supabase, membership\.organizationId/, file);
    assert.match(source, /waitingConversationIds: waiting\.ids/, file);
  }
  assert.doesNotMatch(read("lib/people/next-step.ts"), /ai_enabled/, "AI on/off is not part of waiting");
  assert.doesNotMatch(read("lib/notifications/owner-digest.ts"), /ai_enabled/, "the digest's waiting count is not the AI-off count");
});
