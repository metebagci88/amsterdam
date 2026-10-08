// ASALOCAL · CDP-3B · LOCAL TEST DOUBLE — replaces https://esm.sh/@supabase/supabase-js@2.45.4 via import map ONLY in
// the docker-free local stack (gates/local_stack/run_local.sh). Never deployed; never used against production.
// Surface used by the REAL email-api index.ts for the save-draft flow:
//   auth.getUser()      -> bearer token looked up in local_auth.tokens (GoTrue double)
//   rpc(fn, args)       -> PostgREST double: `select public.fn(arg => $n::type, ...)` on the local Postgres,
//                          named args typed from pg_catalog; error.message = the SQL exception text (as PostgREST)
//   from(t).select(c).in(col, vals) / .eq(col, v).maybeSingle()  -> minimal table read (asset lookups)
//   storage.*           -> not supported (throws; the save-draft gates do not use storage)
// Connects as the local superuser: EXECUTE grants are not exercised here (CI's ephemeral stack covers them).
// All statements go over ONE connection, strictly one at a time (PGlite is a single session; this also avoids the
// socket multiplexer interleaving extended-protocol messages). Consequence: concurrent requests serialise, so true
// parallel-race behaviour (SD5) is only proven in CI on real Postgres; the idempotency outcome is checked here too.
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DB_URL = Deno.env.get("LOCAL_DB_URL") || "";
let _client: Client | null = null;
let _chain: Promise<unknown> = Promise.resolve();
// deno-lint-ignore no-explicit-any
function q(sql: string, args: unknown[] = []): Promise<any[]> {
  const run = async () => {
    if (!DB_URL) throw new Error("LOCAL_DB_URL required");
    if (!_client) { const c = new Client(DB_URL); await c.connect(); _client = c; }
    return (await _client.queryObject(sql, args)).rows;
  };
  const p = _chain.then(run, run);
  _chain = p.catch(() => undefined);
  // deno-lint-ignore no-explicit-any
  return p as Promise<any[]>;
}

export async function tokenUid(authorization: string): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/.exec(authorization || "");
  if (!m) return null;
  const rows = await q("select uid::text as uid from local_auth.tokens where token=$1", [m[1]]);
  return rows.length ? String(rows[0].uid) : null;
}

type Sig = { names: string[]; types: string[]; retset: boolean };
const sigCache = new Map<string, Sig[]>();
async function sigs(fn: string): Promise<Sig[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error("bad function name");
  if (!sigCache.has(fn)) {
    const rows = await q(`select p.proretset as retset, coalesce(p.proargnames,'{}'::text[]) as names,
        array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [fn]);
    sigCache.set(fn, rows.map((r) => ({ names: (r.names as string[]).slice(0, (r.types as string[]).length), types: r.types as string[], retset: !!r.retset })));
  }
  return sigCache.get(fn)!;
}
// deno-lint-ignore no-explicit-any
async function callFn(fn: string, args: Record<string, any>): Promise<unknown> {
  const keys = Object.keys(args);
  const cand = (await sigs(fn)).find((s) => keys.every((k) => s.names.includes(k)));
  if (!cand) throw Object.assign(new Error("Could not find the function public." + fn + " in the schema cache"), { code: "PGRST202" });
  const vals: unknown[] = [];
  const parts = keys.map((k, i) => {
    const t = cand.types[cand.names.indexOf(k)];
    const v = args[k];
    if (t === "jsonb" || t === "json") vals.push(v === null || v === undefined ? null : JSON.stringify(v));
    else vals.push(v === undefined ? null : v);
    return `${k} => $${i + 1}::${t}`;
  });
  const call = `public.${fn}(${parts.join(", ")})`;
  if (cand.retset) return await q(`select * from ${call}`, vals);
  const rows = await q(`select ${call} as r`, vals);
  return rows.length ? rows[0].r : null;
}
// deno-lint-ignore no-explicit-any
function errOf(e: any) {
  const f = e?.fields || {};
  return { message: String(f.message || e?.message || "error"), code: String(f.code || e?.code || ""), details: null, hint: null };
}

class Query {
  private cols = "*";
  private where: { col: string; op: "in" | "eq"; val: unknown }[] = [];
  private single = false;
  constructor(private table: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("bad table");
  }
  select(cols: string) { if (!/^[a-z0-9_*, ]+$/.test(cols)) throw new Error("bad cols"); this.cols = cols; return this; }
  in(col: string, vals: unknown[]) { this.where.push({ col, op: "in", val: vals }); return this; }
  eq(col: string, val: unknown) { this.where.push({ col, op: "eq", val }); return this; }
  maybeSingle() { this.single = true; return this; }
  // deno-lint-ignore no-explicit-any
  async run(): Promise<{ data: any; error: any }> {
    try {
      const vals: unknown[] = []; const conds: string[] = [];
      for (const w of this.where) {
        if (!/^[a-z_][a-z0-9_]*$/.test(w.col)) throw new Error("bad col");
        vals.push(w.op === "in" ? (w.val as unknown[]).map(String) : String(w.val));
        conds.push(w.op === "in" ? `${w.col}::text = any($${vals.length}::text[])` : `${w.col}::text = $${vals.length}`);
      }
      const rows = await q(`select ${this.cols} from public.${this.table}${conds.length ? " where " + conds.join(" and ") : ""}`, vals);
      return { data: this.single ? (rows[0] ?? null) : rows, error: null };
    } catch (e) { return { data: null, error: errOf(e) }; }
  }
  // deno-lint-ignore no-explicit-any
  then(res: (v: { data: any; error: any }) => unknown, rej?: (e: unknown) => unknown) { return this.run().then(res, rej); }
}

// deno-lint-ignore no-explicit-any
export function createClient(_url: string, _key: string, opts?: any) {
  const authz: string = opts?.global?.headers?.Authorization ?? "";
  return {
    auth: {
      async getUser() {
        try {
          const uid = await tokenUid(authz);
          return uid ? { data: { user: { id: uid } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
        } catch (e) { return { data: { user: null }, error: errOf(e) }; }
      },
    },
    // deno-lint-ignore no-explicit-any
    async rpc(fn: string, args: Record<string, any>) {
      try { return { data: await callFn(fn, args || {}), error: null }; } catch (e) { return { data: null, error: errOf(e) }; }
    },
    from(table: string) { return new Query(table); },
    storage: { from(_b: string): never { throw new Error("local stack: storage is not supported"); } },
  };
}
