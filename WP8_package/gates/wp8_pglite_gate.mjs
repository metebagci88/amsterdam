// WP8 PGlite gate (@electric-sql/pglite 0.3.16, PostgreSQL 17, WASM, single connection).
// PG17 compatibility of the whole WP8 package: CI chain (normalized and raw CDP-3D), PRE/POST
// asserts, double apply, inert proof, the acceptance evidence without pg_net/pg_cron, the shared
// behaviour suite, ZF probe, functional rollback, cleanup and re-apply. No network, nothing is
// sent. Sentinel WP8_PGLITE_PASS.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
const req = createRequire(join(process.env.WP8_NODE_MODULES || join(HERE, "node_modules"), "_wp8_resolve.js"));
const { PGlite } = req("@electric-sql/pglite");
const { pgcrypto } = req("@electric-sql/pglite/contrib/pgcrypto");
const EXPECTED = 23;
const BEHAVIOR_EXPECTED = 179;

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (info !== undefined ? " :: " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 600) : "")); } };
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const py = (args) => { const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error("python failed: " + r.stderr); return r.stdout; };
const txn = (sql) => "begin;\n" + sql + "\ncommit;";

async function chain(mode) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  const cdp3d = mode === "norm" ? py([join(ROOT, "WP8_package/tools/wp8_normalize.py"), join(ROOT, "CDP3D_package/CDP3D_up.sql")]) : rd("CDP3D_package/CDP3D_up.sql");
  for (const sql of [rd("CDP3D_package/gates/cdp3d_prereq_stub.sql"), cdp3d, rd("WSE_DEFAULT_package/gates/wse_prereq_extra.sql"),
    rd("WSE_DEFAULT_package/WSE_up.sql"), rd("WP8_package/gates/wp8_ci_baseline.sql"),
    py([join(ROOT, "WP8_package/gates/wp8_cdp3c_fns.py"), ROOT]), rd("WP8_package/gates/wp8_fixture_pre.sql")]) {
    await db.exec(txn(sql));
  }
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];
const json = async (db, file) => Object.values(await one(db, rd(file)))[0];
async function apply(db) { await db.exec(txn(rd("WP8_package/db/WP8_DB_up.sql"))); return true; }
async function behavior(db) {
  await db.exec("begin");
  try {
    await db.exec(rd("WP8_package/gates/wp8_behavior.sql"));
    const rows = (await db.query("select name, pass, info from wp8_t order by seq")).rows;
    return rows;
  } finally { await db.exec("rollback"); }
}

try {
  const db = await chain("norm");
  const ver = (await one(db, "select current_setting('server_version_num')::int v")).v;
  ok("PGlite runs PostgreSQL 17", ver >= 170000 && ver < 180000, ver);
  const pre = await json(db, "WP8_package/db/WP8_DB_pre_assert.sql");
  ok("PRE assert on the fixture -> wp8_pre true", pre.wp8_pre === true, pre.failed);
  ok("apply #1 (normalized) succeeds", await apply(db));
  ok("apply #2 is a no-op", await apply(db));
  const post = await json(db, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert -> wp8_post true, n=43", post.wp8_post === true && post.n === 43, post.failed);
  let ev; try { ev = await json(db, "WP8_package/db/WP8_DB_evidence.sql"); } catch (e) { ev = { error: e.message }; }
  ok("evidence without pg_net and pg_cron (PG17, D2 fallback) returns stop=false with the kick fields null", ev.stop === false && Array.isArray(ev.stop_reasons) && ev.stop_reasons.length === 0
     && ev.global.pg_net_present === false && ev.global.pg_cron_present === false && ev.global.kick_http_this_run_24h === null && ev.global.cron_jobs === null, ev);
  const s = await one(db, "select public.welcome_enqueue_sweep() s");
  ok("inert: sweep -> auto_disabled", JSON.stringify(s.s) === JSON.stringify({ ok: true, gate: "auto_disabled", expired: 0, reconciled: 0 }), s.s);
  ok("inert: claim -> 0 rows", (await one(db, "select count(*)::int n from public.email_claim_batch(10)")).n === 0);
  ok("inert: outbox 3 / events 6 / allowlist 0 / ledger 0", JSON.stringify(await one(db, "select (select count(*)::int from public.email_outbox) o, (select count(*)::int from public.email_send_events) e, (select count(*)::int from public.email_send_allowlist) a, (select count(*)::int from public.email_wp8_run_ledger) l")) === JSON.stringify({ o: 3, e: 6, a: 0, l: 0 }));
  const b = await behavior(db);
  const bf = b.filter((r) => !r.pass);
  ok(`behaviour suite on PG17: ${BEHAVIOR_EXPECTED}/${BEHAVIOR_EXPECTED}`, b.length === BEHAVIOR_EXPECTED && bf.length === 0, bf.map((r) => r.name + " :: " + r.info).slice(0, 10));
  ok("behaviour suite rolled back", (await one(db, "select count(*)::int n from public.email_outbox")).n === 3);
  let zf = "";
  try { await db.exec(rd("WP8_package/db/WP8_DB_zf_probe.sql")); } catch (e) { zf = e.message; }
  ok("ZF probe raises WP8_ZF_DONE with pass=true", zf.includes("WP8_ZF_DONE") && zf.includes('"pass": true'), zf);
  ok("ZF probe left the policy inert", (await one(db, "select (not welcome_auto_enqueue_enabled and welcome_enqueue_from is null and service_daily_cap = 0) ok from public.email_service_policy")).ok === true
     && (await one(db, "select not service_enabled ok from public.email_provider_config")).ok === true);
  await db.exec(rd("WP8_package/db/WP8_DB_rollback.sql").replace(/^/, "begin;\n") + "\ncommit;");
  const rb = await json(db, "WP8_package/db/WP8_DB_post_rollback_assert.sql");
  ok("functional rollback -> post-rollback assert true", rb.wp8_rolled_back === true, rb.failed);
  ok("rollback restored the live CDP-3D claim/mark md5", JSON.stringify(await one(db, "select (select md5(prosrc) from pg_proc where oid = 'public.email_claim_batch(int)'::regprocedure) c, (select md5(prosrc) from pg_proc where oid = 'public.email_mark_result(uuid,boolean,text,text)'::regprocedure) m"))
     === JSON.stringify({ c: "08fc00397182c86929bcb9afa6a6a995", m: "5d34c6af5d4934e23f6508a4a56a562c" }));
  await db.exec(txn(rd("WP8_package/db/WP8_DB_rollback_cleanup_optional.sql")));
  ok("optional cleanup removed WP8 functions, kept data", (await one(db, "select to_regprocedure('public.welcome_enqueue_sweep(int)') is null and to_regclass('public.email_service_policy') is not null ok")).ok === true);
  ok("re-apply after rollback + cleanup", await apply(db));
  const post2 = await json(db, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert after re-apply -> true", post2.wp8_post === true, post2.failed);
  await db.close();

  const raw = await chain("raw");
  ok("apply #1 (raw repo chain) succeeds", await apply(raw));
  ok("apply #2 (raw) no-op", await apply(raw));
  const postr = await json(raw, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert (raw chain) -> true", postr.wp8_post === true, postr.failed);
  const br = await behavior(raw);
  const brf = br.filter((r) => !r.pass);
  ok(`behaviour suite on PG17 (raw chain): ${BEHAVIOR_EXPECTED}/${BEHAVIOR_EXPECTED}`, br.length === BEHAVIOR_EXPECTED && brf.length === 0, brf.map((r) => r.name + " :: " + r.info).slice(0, 10));
  const pfx = await json(raw, "WP8_package/db/WP8_DB_pre_assert.sql");
  ok("PRE assert refuses a database where WP8 is already applied", pfx.wp8_pre === false && pfx.failed.includes("wp8_tables_absent"), pfx.failed);
  await raw.close();
} catch (e) {
  fail++; console.log("FATAL " + e.message + "\n" + (e.stack || ""));
}
console.log(`\nPGLITE RESULT pass=${pass} fail=${fail} expected=${EXPECTED}`);
if (fail === 0 && pass === EXPECTED) console.log("WP8_PGLITE_PASS"); else console.log("WP8_PGLITE_FAIL");
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1);
