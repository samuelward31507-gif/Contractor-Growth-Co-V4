/**
 * Phase 3C: when an estimate, job, appointment, AI or billing read fails, the
 * snapshot's figures for that family are zeroed placeholders - the AI is told
 * so through a dataQuality note, never left to report them as genuine zeros.
 * A genuinely empty organization and complete reads get no failure note.
 * Reads, snapshot fields, partialData and the AI field set are unchanged.
 * Truncation at the API's 1,000-row cap is Phase 3A, not covered here.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/core-metrics.disclosure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean };

/** The Phase 2F-2K fake client: a request that isn't paged gets at most 1,000 rows; `error` fails every request. */
function fakeSupabase(answer: (query: Query) => Answer = () => ({})) {
  const supabase = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      const resolve = (from?: number, to?: number) => {
        const result = answer(query);
        if (result.error) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const rows = result.rows ?? [];
        return Promise.resolve({ data: from === undefined ? rows.slice(0, 1000) : rows.slice(from, to! + 1), error: null, count: rows.length });
      };
      const builder: object = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === "then") return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => resolve().then(onFulfilled, onRejected);
            if (prop === "range") return (from: number, to: number) => (query.calls.push(`range ${from} ${to}`), resolve(from, to));
            if (prop === "single" || prop === "maybeSingle") return () => resolve().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
            return (...args: unknown[]) => (query.calls.push(`${prop} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`), builder);
          },
        },
      );
      return builder;
    },
  } as unknown as SupabaseClient;
  return supabase;
}

const selects = (q: Query, table: string, columns: string) => q.table === table && q.calls.includes(`select ${columns}`);
const isEstimates = (q: Query) => selects(q, "estimates", "status, amount");
const isAcceptedEstimateJobs = (q: Query) => q.table === "estimates" && q.calls.some((c) => c.startsWith("select id, jobs!"));
const isJobs = (q: Query) => selects(q, "jobs", "status, amount");
const isAppointments = (q: Query) => selects(q, "appointments", "status");
const isAiInteractions = (q: Query) => selects(q, "ai_interactions", "interaction_type, model");
const isAiOutputs = (q: Query) => selects(q, "ai_interactions", "interaction_type, output");
const isAiTokens = (q: Query) => selects(q, "ai_interactions", "tokens_used");
const isInvoices = (q: Query) => q.table === "invoices";

/** A small, complete organization: every family has real rows. */
const baseAnswer = (q: Query): Answer => {
  if (isEstimates(q)) return { rows: [{ status: "accepted", amount: 1000 }, { status: "declined", amount: 500 }] };
  if (isAcceptedEstimateJobs(q)) return { rows: [{ id: "e1", jobs: [{ id: "j1" }] }] };
  if (isJobs(q)) return { rows: [{ status: "completed", amount: 1000 }] };
  if (isAppointments(q)) return { rows: [{ status: "completed" }, { status: "no_show" }] };
  if (isAiInteractions(q)) return { rows: [{ interaction_type: "customer_reply_response", model: "m" }] };
  if (isAiOutputs(q)) return { rows: [{ interaction_type: "customer_reply_response", output: {} }] };
  if (isAiTokens(q)) return { rows: [{ tokens_used: 120 }] };
  return {};
};

const NOW = new Date("2026-09-25T12:00:00Z");
const snapshotWith = (answer: (q: Query) => Answer) => getBusinessMetricsSnapshot(fakeSupabase(answer), "org-1", "last30Days", { now: NOW });
const notesOf = (s: Awaited<ReturnType<typeof snapshotWith>>) => buildAiInsightsInput(s).dataQuality.notes;
const hasNote = (notes: string[], prefix: string) => notes.some((n) => n.startsWith(prefix));

const NOTE = {
  estimates: "Estimate counts could not be read for this snapshot",
  jobs: "Job counts could not be read for this snapshot",
  appointments: "Appointment counts could not be read for this snapshot",
  ai: "AI interaction counts could not be read for this snapshot",
  billing: "The invoice and payment ledger could not be read for this snapshot",
};
const TOKEN_NOTE_PREFIXES = ["No ai_interactions row in this period has provider-reported token usage", "Token usage is available for"];
const AI_FIELDS = ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"];

test("a failed estimate, job, appointment, AI or billing read tells the AI that family is zeroed - and only that family; partialData and the AI field set unchanged", async () => {
  const cases: [string, (q: Query) => boolean, keyof typeof NOTE][] = [
    ["estimates", isEstimates, "estimates"],
    ["accepted estimate -> job", isAcceptedEstimateJobs, "estimates"],
    ["jobs", isJobs, "jobs"],
    ["appointments", isAppointments, "appointments"],
    ["AI interactions", isAiInteractions, "ai"],
    ["AI output fields", isAiOutputs, "ai"],
    ["AI token usage", isAiTokens, "ai"],
    ["billing ledger", isInvoices, "billing"],
  ];
  for (const [name, failing, family] of cases) {
    const s = await snapshotWith((q) => (failing(q) ? { error: true } : baseAnswer(q)));
    const notes = notesOf(s);
    assert.ok(hasNote(notes, NOTE[family]), `${name}: its note is present`);
    for (const other of Object.keys(NOTE) as (keyof typeof NOTE)[]) {
      if (other !== family) assert.ok(!hasNote(notes, NOTE[other]), `${name}: no ${other} note`);
    }
    assert.equal(s.partialData, true, `${name}: the existing failed flag still feeds partialData`);
    assert.deepEqual(Object.keys(buildAiInsightsInput(s)).sort(), AI_FIELDS, name);
  }
});

test("the billing failure note also names the invoiced and collected comparisons", async () => {
  const s = await snapshotWith((q) => (isInvoices(q) ? { error: true } : baseAnswer(q)));
  const note = notesOf(s).find((n) => n.startsWith(NOTE.billing));
  assert.match(note ?? "", /comparisons\.invoicedValue and comparisons\.collectedValue are unavailable/);
});

test("a failed AI read replaces the token-usage note - the AI is never told n8n didn't report usage when the read itself failed", async () => {
  for (const failing of [isAiInteractions, isAiOutputs, isAiTokens]) {
    const notes = notesOf(await snapshotWith((q) => (failing(q) ? { error: true } : baseAnswer(q))));
    assert.ok(hasNote(notes, NOTE.ai));
    for (const prefix of TOKEN_NOTE_PREFIXES) assert.ok(!hasNote(notes, prefix), prefix);
  }
});

test("complete reads and a genuinely empty organization get no failure note, and keep the usual token-usage and ledger notes", async () => {
  const complete = notesOf(await snapshotWith(baseAnswer));
  for (const prefix of Object.values(NOTE)) assert.ok(!hasNote(complete, prefix), `complete: ${prefix}`);
  assert.ok(hasNote(complete, "Token usage is available for 1 of 1 AI interaction(s)"));

  const empty = await snapshotWith(() => ({}));
  const emptyNotes = notesOf(empty);
  for (const prefix of Object.values(NOTE)) assert.ok(!hasNote(emptyNotes, prefix), `empty: ${prefix}`);
  assert.ok(hasNote(emptyNotes, TOKEN_NOTE_PREFIXES[0]), "a genuinely empty organization keeps the no-usage note");
  assert.deepEqual([empty.estimateMetrics.totalEstimates, empty.jobMetrics.totalJobs, empty.appointmentMetrics.totalAppointments, empty.aiMetrics.aiInteractions, empty.partialData], [0, 0, 0, 0, false]);
});

test("guard: partialData inputs are byte-identical to main", () => {
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const main = execFileSync("git", ["show", "eccc37a0026cf52fc236fe2d8d4db43078e029b7:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
});
