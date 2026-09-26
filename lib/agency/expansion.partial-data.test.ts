/**
 * Unit tests for getAgencyExpansionOpportunities's partialData contract,
 * against a hand-built mocked Supabase client - no real database. Mirrors
 * this codebase's own established technique for exactly this problem (see
 * lib/dashboard/queries.partial-data.test.ts's own header comment): forcing
 * a genuine Postgrest error through a real, authorized database call isn't
 * practical in an integration test, so the mock replaces only the
 * `{ data, error }` response at the wire boundary, never the function's own
 * logic - the real resolveAgencyOrganizations / getAgencyExpansionOpportunities
 * code runs unmodified against these mocked responses.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/expansion.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getAgencyExpansionOpportunities }: typeof import("./expansion") = require("./expansion.ts");

type MockResult = { data: unknown; error: { message: string } | null };

/** A minimal, thenable chainable query-builder stub - callable at any point in the chain (`await` after any number of .select()/.eq()/.order()/.limit() calls), matching how the real Supabase/PostgREST client's builder itself resolves. `resolve` is re-evaluated at await-time against whatever `.eq()` filters were applied earlier in the same synchronous call chain. */
function makeQueryBuilder(resolve: (filters: Record<string, unknown>) => MockResult) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(resolve(filters)),
    then: (onFulfilled?: ((value: MockResult) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
      Promise.resolve(resolve(filters)).then(onFulfilled ?? undefined, onRejected ?? undefined),
  };
  return builder;
}

function makeAdminSessionClient(): SupabaseClient {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "admin-1" } } }) },
    rpc: () => Promise.resolve({ data: true, error: null }),
  } as unknown as SupabaseClient;
}

function makeServiceClient(options: {
  organizations: { organization_id: string; created_at: string; organizations: { name: string } }[];
  opportunitiesResultForOrg: (organizationId: string) => MockResult;
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "agency_organizations") {
        return makeQueryBuilder(() => ({ data: options.organizations, error: null }));
      }
      if (table === "opportunities") {
        return makeQueryBuilder((filters) => options.opportunitiesResultForOrg(filters.organization_id as string));
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function opportunityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "opp-1",
    type: "stale_estimate",
    status: "open",
    source_entity_type: "estimate",
    source_entity_id: "est-1",
    contact_id: "contact-1",
    title: "Stale estimate",
    description: "An estimate expired with no decision.",
    estimated_value: 5000,
    value_basis: "estimates.amount",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    metadata: {},
    ...overrides,
  };
}

test("1. a real Postgrest error on one organization's opportunities read sets partialData - a sibling organization's genuinely successful read is still fully reflected", async () => {
  const session = makeAdminSessionClient();
  const service = makeServiceClient({
    organizations: [
      { organization_id: "org-a", created_at: "2026-01-01T00:00:00.000Z", organizations: { name: "Org A" } },
      { organization_id: "org-b", created_at: "2026-01-01T00:00:00.000Z", organizations: { name: "Org B" } },
    ],
    opportunitiesResultForOrg: (organizationId) =>
      organizationId === "org-a"
        ? { data: null, error: { message: "connection reset by peer" } }
        : { data: [opportunityRow({ id: "opp-b", source_entity_id: "est-b" })], error: null },
  });

  const result = await getAgencyExpansionOpportunities(session, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.partialData, true, "a real error on org-a's read must be disclosed, never silently rendered as org-a having zero opportunities");
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0]!.organizationId, "org-b");
});

test("2. a genuinely empty, successful result for every organization never sets partialData - emptiness and failure stay two different things", async () => {
  const session = makeAdminSessionClient();
  const service = makeServiceClient({
    organizations: [{ organization_id: "org-a", created_at: "2026-01-01T00:00:00.000Z", organizations: { name: "Org A" } }],
    opportunitiesResultForOrg: () => ({ data: [], error: null }),
  });

  const result = await getAgencyExpansionOpportunities(session, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.partialData, false);
  assert.equal(result.opportunities.length, 0);
});

test("3. failures on every organization's read still return ok:true with partialData true and an empty opportunity list - never an error to the caller", async () => {
  const session = makeAdminSessionClient();
  const service = makeServiceClient({
    organizations: [{ organization_id: "org-a", created_at: "2026-01-01T00:00:00.000Z", organizations: { name: "Org A" } }],
    opportunitiesResultForOrg: () => ({ data: null, error: { message: "timeout" } }),
  });

  const result = await getAgencyExpansionOpportunities(session, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.partialData, true);
  assert.equal(result.opportunities.length, 0);
  assert.equal(result.summary.openOpportunityCount, 0);
});
