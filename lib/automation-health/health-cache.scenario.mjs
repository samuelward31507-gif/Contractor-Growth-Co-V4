// Phase 2A-1: scenario run by health.cache.test.ts in a child process.
// health.ts's own `import { cache } from "react"` is resolved to React's
// server build (react.react-server.js) - the build whose cache() memoizes
// per request, exactly as in a Next.js server render - while every other
// module keeps the normal build (some of health.ts's dependencies, like the
// automation catalog's icon imports, only load there; Next's bundler makes
// the same split). A request is simulated the way React does it: an active
// cache dispatcher whose per-request store is created fresh per request.
// Prints one JSON line with the observed Supabase call counts.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const serverReactUrl = pathToFileURL(path.resolve("node_modules/react/react.react-server.js")).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
        if (specifier === "react" && context.parentURL && context.parentURL.endsWith("/lib/automation-health/health.ts")) return { url: ${JSON.stringify(serverReactUrl)}, shortCircuit: true };
        return next(specifier, context);
      }`,
    ),
);
const React = (await import(serverReactUrl)).default;

const internals = React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
function startRequest() {
  const store = new Map();
  internals.A = { getCacheForType: (create) => (store.has(create) ? store.get(create) : (store.set(create, create()), store.get(create))) };
}
function endRequest() {
  internals.A = null;
}

function countingClient() {
  const counter = { from: 0, rpc: 0 };
  const result = { data: [], error: null, count: 0 };
  const builder = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") return (resolve) => resolve(result);
        if (prop === "maybeSingle" || prop === "single") return () => ({ then: (resolve) => resolve({ data: null, error: null }) });
        return () => builder;
      },
    },
  );
  const client = {
    from: () => (counter.from++, builder),
    rpc: () => (counter.rpc++, builder),
  };
  return { client, counter };
}

const { getOrganizationHealth } = await import(new URL("./health.ts", import.meta.url).href);
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const out = {};

// 1. One request, one client, one organization: the top bar, the daily
//    briefing and the end-of-day summary all ask.
{
  const { client, counter } = countingClient();
  startRequest();
  const [topBar, briefing, endOfDay] = await Promise.all([getOrganizationHealth(client, ORG_A), getOrganizationHealth(client, ORG_A), getOrganizationHealth(client, ORG_A)]);
  out.sameRequest = { calls: counter.from + counter.rpc, rpc: counter.rpc, sharedResult: topBar === briefing && briefing === endOfDay };
  // 2. Same request, a different organization: computed separately.
  const beforeOther = counter.from + counter.rpc;
  const other = await getOrganizationHealth(client, ORG_B);
  out.otherOrganization = { extraCalls: counter.from + counter.rpc - beforeOther, notShared: other !== topBar };
  endRequest();
  // 3. A new request: nothing carried over.
  startRequest();
  const beforeNext = counter.from + counter.rpc;
  const next = await getOrganizationHealth(client, ORG_A);
  out.nextRequest = { extraCalls: counter.from + counter.rpc - beforeNext, notShared: next !== topBar };
  endRequest();
}

// 4. Same request and organization, a different client (e.g. service role vs session): not shared.
{
  const a = countingClient();
  const b = countingClient();
  startRequest();
  const ra = await getOrganizationHealth(a.client, ORG_A);
  const rb = await getOrganizationHealth(b.client, ORG_A);
  out.otherClient = { callsA: a.counter.from + a.counter.rpc, callsB: b.counter.from + b.counter.rpc, notShared: ra !== rb };
  endRequest();
}

// 5. Outside any request (route handlers, scripts): plain pass-through.
{
  const { client, counter } = countingClient();
  await getOrganizationHealth(client, ORG_A);
  const single = counter.from + counter.rpc;
  await getOrganizationHealth(client, ORG_A);
  out.outsideRequest = { firstCalls: single, secondCallsAgain: counter.from + counter.rpc - single };
}

console.log(JSON.stringify(out));
