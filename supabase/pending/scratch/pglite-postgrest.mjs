// A small PostgREST-compatible HTTP layer over PGlite, for the Dashboard SQL
// parity harness (validate-dashboard-sql.mjs). It lets the application's real
// loaders run unchanged through @supabase/supabase-js against an in-memory
// database built from the real migrations.
//
// Supports exactly what the Dashboard loaders use - select lists with
// many-to-one embeds (`contact:contacts(...)`, `contacts(...)`), eq/neq/gt/
// gte/lt/lte/in/is/like/ilike (and `not.`), order, limit, offset, exact
// counts, HEAD, single-object responses, and POST /rpc/<fn>. Anything else
// throws, so a gap can never silently change a result. Responses are
// serialized by Postgres itself (json_agg), so numbers, timestamps and nulls
// come back exactly as PostgREST would send them. Reads run as the PGlite
// superuser (RLS is exercised separately by the harness).
import http from "node:http";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);
const singular = (table) => (table.endsWith("ies") ? table.slice(0, -3) + "y" : table.endsWith("s") ? table.slice(0, -1) : table);

function splitTop(str) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(str) {
  return splitTop(str || "*").map((item) => {
    const embed = item.match(/^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)\((.*)\)$/s);
    if (embed) return { type: "embed", alias: embed[1] ?? null, table: embed[2], items: parseSelect(embed[3]) };
    if (item === "*") return { type: "star" };
    const rename = item.match(/^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)$/);
    if (rename) return { type: "col", key: rename[1], name: rename[2] };
    if (!IDENT.test(item)) throw new Error(`pglite-postgrest: unsupported select item "${item}"`);
    return { type: "col", key: item, name: item };
  });
}

export async function startPostgrest(db, { onRequest } = {}) {
  const columnsCache = new Map();
  async function columns(table) {
    if (!columnsCache.has(table)) {
      const r = await db.query(`select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table]);
      if (r.rows.length === 0) throw new Error(`pglite-postgrest: unknown table ${table}`);
      columnsCache.set(table, new Map(r.rows.map((c) => [c.column_name, c.udt_name])));
    }
    return columnsCache.get(table);
  }

  async function buildObject(alias, table, items, depth) {
    const cols = await columns(table);
    const parts = [];
    for (const item of items) {
      if (item.type === "star") {
        for (const name of cols.keys()) parts.push(`'${name}', ${alias}.${name}`);
      } else if (item.type === "col") {
        if (!cols.has(item.name)) throw new Error(`pglite-postgrest: unknown column ${table}.${item.name}`);
        parts.push(`'${item.key}', ${alias}.${item.name}`);
      } else {
        const fk = `${item.alias ?? singular(item.table)}_id`;
        if (!cols.has(fk)) throw new Error(`pglite-postgrest: cannot resolve embed ${item.table} on ${table} (no ${fk})`);
        const inner = `e${depth}`;
        const innerObj = await buildObject(inner, item.table, item.items, depth + 1);
        parts.push(`'${item.alias ?? item.table}', (select ${innerObj} from public.${item.table} ${inner} where ${inner}.id = ${alias}.${fk})`);
      }
    }
    const chunks = [];
    for (let i = 0; i < parts.length; i += 40) chunks.push(`jsonb_build_object(${parts.slice(i, i + 40).join(", ")})`);
    return chunks.length ? chunks.join(" || ") : `'{}'::jsonb`;
  }

  async function where(table, params, values) {
    const cols = await columns(table);
    const clauses = [];
    for (const [key, raw] of params) {
      if (RESERVED.has(key)) continue;
      if (key === "or" || key === "and") throw new Error(`pglite-postgrest: unsupported logical filter ${key}`);
      if (!cols.has(key)) throw new Error(`pglite-postgrest: unknown filter column ${table}.${key}`);
      let rest = raw;
      let negate = false;
      if (rest.startsWith("not.")) {
        negate = true;
        rest = rest.slice(4);
      }
      const dot = rest.indexOf(".");
      const op = rest.slice(0, dot);
      const value = rest.slice(dot + 1);
      const col = `t.${key}`;
      let clause;
      if (op === "is") {
        if (value === "null") clause = `${col} is null`;
        else if (value === "true" || value === "false") clause = `${col} is ${value}`;
        else throw new Error(`pglite-postgrest: unsupported is.${value}`);
      } else if (op === "eq" || op === "neq") {
        values.push(value);
        clause = `${col}::text ${op === "eq" ? "=" : "<>"} $${values.length}`;
      } else if (["gt", "gte", "lt", "lte"].includes(op)) {
        values.push(value);
        clause = `${col} ${{ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]} $${values.length}::${cols.get(key)}`;
      } else if (op === "in") {
        const list = value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
        values.push(`{${list.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")}}`);
        clause = `${col}::text = any($${values.length}::text[])`;
      } else if (op === "like" || op === "ilike") {
        values.push(value.replace(/\*/g, "%"));
        clause = `${col}::text ${op} $${values.length}`;
      } else throw new Error(`pglite-postgrest: unsupported operator ${op}`);
      clauses.push(negate ? `not (${clause})` : clause);
    }
    return clauses.length ? `where ${clauses.join(" and ")}` : "";
  }

  async function orderBy(table, order) {
    if (!order) return "";
    const cols = await columns(table);
    return (
      "order by " +
      order
        .split(",")
        .map((part) => {
          const [name, ...mods] = part.split(".");
          if (!cols.has(name)) throw new Error(`pglite-postgrest: unknown order column ${table}.${name}`);
          const dir = mods.includes("desc") ? "desc" : "asc";
          const nulls = mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : "";
          return `t.${name} ${dir}${nulls}`;
        })
        .join(", ")
    );
  }

  async function handleTable(req, url, table) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new Error(`pglite-postgrest: ${req.method} not supported (read-only)`);
    const params = [...url.searchParams.entries()];
    const values = [];
    const w = await where(table, params, values);
    const o = await orderBy(table, url.searchParams.get("order"));
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const obj = await buildObject("t", table, parseSelect(url.searchParams.get("select")), 1);
    const lim = limit ? `limit ${Number(limit)}` : "";
    const off = offset ? `offset ${Number(offset)}` : "";
    const sql = `select coalesce(json_agg(q.r order by q.ord), '[]')::text as body, count(*)::int as n from (select ${obj} as r, row_number() over (${o}) as ord from public.${table} t ${w} ${o} ${lim} ${off}) q`;
    const result = await db.query(sql, values);
    const body = result.rows[0].body;
    const n = result.rows[0].n;
    const prefer = req.headers.prefer ?? "";
    const headers = { "content-type": "application/json; charset=utf-8" };
    let total = "*";
    if (/count=exact/.test(prefer)) {
      const c = await db.query(`select count(*)::int as c from public.${table} t ${w}`, values);
      total = String(c.rows[0].c);
    }
    headers["content-range"] = n > 0 ? `0-${n - 1}/${total}` : `*/${total}`;
    onRequest?.({ kind: "rest", method: req.method, table, rows: req.method === "HEAD" ? 0 : n });
    if (req.method === "HEAD") return { status: 200, headers, body: "" };
    if ((req.headers.accept ?? "").includes("application/vnd.pgrst.object+json")) {
      const rows = JSON.parse(body);
      if (rows.length !== 1) return { status: 406, headers, body: JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null }) };
      return { status: 200, headers: { ...headers, "content-type": "application/vnd.pgrst.object+json; charset=utf-8" }, body: JSON.stringify(rows[0]) };
    }
    return { status: 200, headers, body };
  }

  async function handleRpc(req, fn, rawBody) {
    if (!IDENT.test(fn)) throw new Error(`pglite-postgrest: bad function name ${fn}`);
    const args = rawBody ? JSON.parse(rawBody) : {};
    const meta = await db.query(`select p.proretset, p.proargnames, oidvectortypes(p.proargtypes) as argtypes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
    if (meta.rows.length !== 1) throw new Error(`pglite-postgrest: function ${fn} not found (or overloaded)`);
    const { proretset, proargnames, argtypes } = meta.rows[0];
    const types = argtypes ? argtypes.split(", ") : [];
    const names = (proargnames ?? []).slice(0, types.length);
    const values = [];
    const call = names
      .filter((name) => Object.prototype.hasOwnProperty.call(args, name))
      .map((name) => {
        const v = args[name];
        values.push(v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
        return `${name} => $${values.length}::${types[names.indexOf(name)]}`;
      })
      .join(", ");
    const sql = proretset ? `select coalesce(json_agg(to_jsonb(x)), '[]')::text as body, count(*)::int as n from public.${fn}(${call}) x` : `select to_jsonb(public.${fn}(${call}))::text as body, 1 as n`;
    const result = await db.query(sql, values);
    onRequest?.({ kind: "rpc", method: "POST", table: fn, rows: result.rows[0].n });
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: result.rows[0].body ?? "null" };
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = url.pathname.replace(/^\/rest\/v1\//, "");
        const out = path.startsWith("rpc/") ? await handleRpc(req, path.slice(4), raw) : await handleTable(req, url, path);
        res.writeHead(out.status, out.headers).end(out.body);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message.startsWith("pglite-postgrest:")) {
          // A gap in this adapter must fail the harness loudly, never degrade a result.
          console.error(message);
          process.exitCode = 3;
        }
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: "XX000", message, details: null, hint: null }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
