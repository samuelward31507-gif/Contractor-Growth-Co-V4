/**
 * Phase 1C test support, imported only by lib/payments/*.test.ts (not a test
 * file itself, and never imported by application code): an in-memory fake
 * Supabase client and a fake Stripe client for the lib/payments unit tests. Same
 * approach as lib/invoices/service.test.ts's fake - simple filters, every
 * call recorded, database errors injectable - so a test observes exactly
 * what a service asks the database and Stripe for. Nothing here touches the
 * network, .env.local, or a real key.
 */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;
export type Filter = [op: "eq" | "neq" | "is", column: string, value: unknown];
export type DbCall = { table: string; op: "select" | "insert" | "update" | "delete"; columns?: string; payload?: unknown; filters: Filter[] };
export type DbError = { code: string; message: string };

export type FakeDbOptions = {
  /** Emulates triggers: may return a modified row and mutate other tables. */
  onInsert?: (table: string, row: Row, tables: Record<string, Row[]>) => Row;
  insertError?: (table: string, row: Row, tables: Record<string, Row[]>) => DbError | null;
  rpc?: (fn: string, args: Row) => { data: unknown; error: DbError | null };
};

export function makeFakeSupabase(tables: Record<string, Row[]>, options: FakeDbOptions = {}) {
  const calls: DbCall[] = [];
  const rpcCalls: { fn: string; args: Row }[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    let op: DbCall["op"] = "select";
    let columns: string | undefined;
    let payload: unknown;
    let single = false;
    let maybe = false;

    const matches = (row: Row) =>
      filters.every(([kind, column, value]) => {
        if (kind === "eq") return row[column] === value;
        if (kind === "neq") return row[column] !== value;
        return (row[column] ?? null) === value;
      });

    function execute() {
      const rows = (tables[table] ??= []);
      calls.push({ table, op, columns, payload, filters: [...filters] });
      let result: Row[] = [];
      if (op === "select") {
        result = rows.filter(matches);
      } else if (op === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
        for (const row of incoming) {
          const err = options.insertError?.(table, row, tables);
          if (err) return { data: null, error: err };
        }
        result = incoming.map((row, i) => {
          const base: Row = { id: `${table}-${rows.length + i + 1}`, ...row };
          return options.onInsert ? options.onInsert(table, base, tables) : base;
        });
        rows.push(...result);
      } else if (op === "update") {
        result = rows.filter(matches);
        for (const row of result) Object.assign(row, payload as Row);
      }
      if (single) return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      if (maybe) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }

    const b: Record<string, unknown> = {
      select: (cols?: string) => ((columns = columns ?? cols), b),
      insert: (rows: unknown) => ((op = "insert"), (payload = rows), b),
      update: (patch: unknown) => ((op = "update"), (payload = patch), b),
      delete: () => ((op = "delete"), b),
      eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), b),
      neq: (column: string, value: unknown) => (filters.push(["neq", column, value]), b),
      is: (column: string, value: unknown) => (filters.push(["is", column, value]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => ((maybe = true), b),
      single: () => ((single = true), b),
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    };
    return b;
  }

  const client = {
    from: builder,
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const result = options.rpc ? options.rpc(fn, args) : { data: {}, error: null };
      return { single: () => Promise.resolve(result), then: (resolve: (value: unknown) => void) => resolve(result) };
    },
  } as unknown as SupabaseClient;

  const writes = (table?: string) => calls.filter((call) => call.op !== "select" && (table === undefined || call.table === table));
  return { client, calls, rpcCalls, tables, writes };
}

export type StripeCall = { method: string; args: unknown[] };

export type FakeStripeBehavior = {
  /** Accounts v2 only - the v1 accounts/accountLinks resources are deliberately absent from the fake, so any v1 call fails the test. */
  v2AccountsCreate?: (params: Stripe.V2.Core.AccountCreateParams, options?: Stripe.RequestOptions) => Partial<Stripe.V2.Core.Account>;
  v2AccountsRetrieve?: (id: string, params?: Stripe.V2.Core.AccountRetrieveParams) => Partial<Stripe.V2.Core.Account>;
  v2AccountLinksCreate?: (params: Stripe.V2.Core.AccountLinkCreateParams) => Partial<Stripe.V2.Core.AccountLink>;
  sessionsCreate?: (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => Partial<Stripe.Checkout.Session>;
  paymentIntentsRetrieve?: (id: string, params?: unknown, options?: Stripe.RequestOptions) => Partial<Stripe.PaymentIntent>;
  /** Real signature helpers (constructEvent / generateTestHeaderString are local HMAC) - pass the guarded client's own `webhooks`. */
  webhooks?: Stripe["webhooks"];
  /** Real thin-event verification + parsing - pass the guarded client's own `parseEventNotification`, bound to it. */
  parseEventNotification?: Stripe["parseEventNotification"];
};

function notConfigured(method: string): never {
  throw new Error(`fake Stripe: ${method} was not expected in this test`);
}

/** A Stripe stand-in exposing only the methods Phase 1C calls. A behavior that throws simulates a Stripe API error. */
export function makeFakeStripe(behavior: FakeStripeBehavior = {}) {
  const calls: StripeCall[] = [];
  const record = <T>(method: string, args: unknown[], impl: (() => T) | undefined): Promise<T> => {
    calls.push({ method, args });
    return new Promise((resolve, reject) => {
      try {
        resolve(impl ? impl() : notConfigured(method));
      } catch (error) {
        reject(error);
      }
    });
  };
  const stripe = {
    v2: {
      core: {
        accounts: {
          create: (params: Stripe.V2.Core.AccountCreateParams, options?: Stripe.RequestOptions) => record("v2.core.accounts.create", [params, options], behavior.v2AccountsCreate && (() => behavior.v2AccountsCreate!(params, options))),
          retrieve: (id: string, params?: Stripe.V2.Core.AccountRetrieveParams) => record("v2.core.accounts.retrieve", [id, params], behavior.v2AccountsRetrieve && (() => behavior.v2AccountsRetrieve!(id, params))),
        },
        accountLinks: {
          create: (params: Stripe.V2.Core.AccountLinkCreateParams) => record("v2.core.accountLinks.create", [params], behavior.v2AccountLinksCreate && (() => behavior.v2AccountLinksCreate!(params))),
        },
      },
    },
    checkout: {
      sessions: {
        create: (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => record("checkout.sessions.create", [params, options], behavior.sessionsCreate && (() => behavior.sessionsCreate!(params, options))),
      },
    },
    paymentIntents: {
      retrieve: (id: string, params?: unknown, options?: Stripe.RequestOptions) => record("paymentIntents.retrieve", [id, params, options], behavior.paymentIntentsRetrieve && (() => behavior.paymentIntentsRetrieve!(id, params, options))),
    },
    webhooks: behavior.webhooks,
    parseEventNotification: behavior.parseEventNotification,
  } as unknown as Stripe;
  return { stripe, calls };
}

/** A Stripe-shaped API error (what the SDK throws): type + message, never a key. */
export function stripeApiError(message: string): Error {
  return Object.assign(new Error(message), { type: "StripeAPIError" });
}

/** Runs `fn` with the payments key, STRIPE_CONNECT_SECRET_KEY, temporarily set (and Vercel production flags cleared), restoring the environment afterwards. */
export async function withStripeKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { key: process.env.STRIPE_CONNECT_SECRET_KEY, vercel: process.env.VERCEL, vercelEnv: process.env.VERCEL_ENV };
  if (key === undefined) delete process.env.STRIPE_CONNECT_SECRET_KEY;
  else process.env.STRIPE_CONNECT_SECRET_KEY = key;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  try {
    return await fn();
  } finally {
    for (const [name, value] of [["STRIPE_CONNECT_SECRET_KEY", saved.key], ["VERCEL", saved.vercel], ["VERCEL_ENV", saved.vercelEnv]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

type CapabilityStatus = "active" | "pending" | "restricted" | "unsupported";
type RequirementEntry = { status: "currently_due" | "eventually_due" | "past_due"; awaitingActionFrom?: "user" | "stripe" };

/**
 * A v2 Account as Stripe returns it with include: ["configuration.merchant",
 * "requirements"]. `card`/`payouts` of null omit that capability;
 * `configuration: false` omits the merchant configuration; `requirements:
 * false` omits the requirements hash (as when it was not included).
 */
export function v2Account(options: {
  id?: string;
  organizationId?: string | null;
  card?: CapabilityStatus | null;
  payouts?: CapabilityStatus | null;
  requirements?: RequirementEntry[] | false;
  configuration?: boolean;
} = {}): Stripe.V2.Core.Account {
  const capabilities: Record<string, unknown> = {};
  if (options.card !== null) capabilities.card_payments = { status: options.card ?? "active", status_details: [] };
  if (options.payouts !== null) capabilities.stripe_balance = { payouts: { status: options.payouts ?? "active", status_details: [] } };
  const account: Record<string, unknown> = {
    id: options.id ?? "acct_1TestConnect000001",
    object: "v2.core.account",
    applied_configurations: options.configuration === false ? [] : ["merchant"],
    created: "2026-10-01T00:00:00.000Z",
    dashboard: "full",
    livemode: false,
    metadata: options.organizationId === null ? {} : { organization_id: options.organizationId ?? "11111111-1111-4111-8111-111111111111" },
  };
  if (options.configuration !== false) account.configuration = { merchant: { applied: true, capabilities } };
  if (options.requirements !== false) {
    account.requirements = {
      entries: (options.requirements ?? []).map((entry, i) => ({
        awaiting_action_from: entry.awaitingActionFrom ?? "user",
        description: `requirement ${i}`,
        errors: [],
        impact: {},
        minimum_deadline: { status: entry.status },
        requested_reasons: [],
      })),
    };
  }
  return account as unknown as Stripe.V2.Core.Account;
}
